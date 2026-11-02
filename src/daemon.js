/*
 * Background dictation daemon.
 *
 * Started as a child of the menu bar app. It speaks JSON lines on stdin/stdout
 * with the app, and owns the microphone, ASR service, clipboard, and history.
 * The terminal is not involved.
 */

import readline from "node:readline";
import { RecognizerClient } from "./asr-client.js";
import { copyToClipboard } from "./clipboard.js";
import { readConfig } from "./daemon-config.js";
import { addHistory, HISTORY_LIMIT, loadHistory, saveHistory } from "./history.js";
import { ensureModel, resolveHome } from "./model.js";
import { Recorder, RecorderError } from "./recorder.js";
import { int16ToFloat32, peak } from "./util.js";

const SR = 16_000;
const RING_SECONDS = 2;
const WARM_PRE_ROLL_MS = 250;
const COLD_PRE_ROLL_MS = 2_000;
const MAX_RECORDING_MS = 300_000;

function parseArgs(argv) {
  const options = { home: null, recorder: null, warm: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home" && i + 1 < argv.length) options.home = argv[++i];
    else if (arg.startsWith("--home=")) options.home = arg.slice(7);
    else if (arg === "--recorder" && i + 1 < argv.length) options.recorder = argv[++i];
    else if (arg.startsWith("--recorder=")) options.recorder = arg.slice(11);
    else if (arg === "--warm" && i + 1 < argv.length) options.warm = Number(argv[++i]);
    else if (arg.startsWith("--warm=")) options.warm = Number(arg.slice(7));
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const paths = resolveHome(args.home);

let config = { hotkey: "ctrl+alt+space", sounds: true, warmSeconds: 120, recorder: null };
try {
  config = await readConfig(paths);
} catch (error) {
  console.error(`myna daemon: ignoring invalid config: ${error.message}`);
}
if (Number.isInteger(args.warm) && args.warm >= -1) config.warmSeconds = args.warm;
if (args.recorder) config.recorder = args.recorder;

const warmSeconds = config.warmSeconds;

let phase = "starting";
let mic = "cold";
let recognizer = null;
let recorder = null;
let history = [];
let ring = [];
let ringSamples = 0;
let recording = null;
let warmTimer = null;
let maxTimer = null;
let warmPromise = null;
let pendingStart = false;
let shuttingDown = false;
let modelAbort = null;
let initPromise = null;

function send(message) {
  if (shuttingDown) return;
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    shutdown();
  }
}

function sendStatus(state, extra = {}) {
  phase = state;
  if (extra.mic) mic = extra.mic;
  send({ type: "status", state, mic, ...extra });
}

function log(...parts) {
  console.error(`myna daemon: ${parts.map((part) => (typeof part === "string" ? part : safe(part))).join(" ")}`);
}

function safe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ---------------------------------------------------------------- startup */

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    sendStatus("loading", { detail: "opening the recognizer…" });
    modelAbort = new AbortController();

    const modelTask = initModel();
    const recorderTask = initRecorder();
    const [modelResult, recorderResult] = await Promise.allSettled([modelTask, recorderTask]);
    if (shuttingDown) return;

    if (modelResult.status === "rejected") {
      log("model failed", modelResult.reason);
      sendStatus("error", {
        code: "MODEL",
        message: modelResult.reason?.message ?? String(modelResult.reason),
        mic,
      });
      return;
    }
    if (recorderResult.status === "rejected") {
      log("recorder failed", recorderResult.reason);
      sendStatus("error", {
        code: "RECORDER",
        message: recorderResult.reason?.message ?? String(recorderResult.reason),
        mic,
      });
      return;
    }

    sendStatus("idle", { mic: "cold", detail: "" });
    if (pendingStart) {
      pendingStart = false;
      beginRecording().catch((error) => log("could not start", error));
    }
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function initModel() {
  let lastProgress = 0;
  await ensureModel({
    paths,
    signal: modelAbort.signal,
    onProgress: (progress) => {
      if (shuttingDown) return;
      const now = Date.now();
      if (now - lastProgress < 200) return;
      lastProgress = now;
      sendStatus("loading", {
        detail: "downloading the model…",
        progress: progress.total ? progress.loaded / progress.total : 0,
      });
    },
    onStatus: (event) => {
      if (shuttingDown) return;
      if (event.phase === "done") sendStatus("loading", { detail: "loading the recognizer…" });
    },
  });
  if (shuttingDown) return;

  const client = new RecognizerClient({ log: (line) => log(line) });
  try {
    await client.load({
      modelDir: paths.models,
      ep: "auto",
      threads: 0,
      onStatus: (event) => {
        if (shuttingDown) return;
        const messages = {
          vocab: "reading the vocabulary…",
          preprocessor: "opening the preprocessor…",
          decoder: "opening the decoder…",
          encoder: "opening the encoder…",
          warmup: "warming up the recognizer…",
        };
        if (event.phase === "encoder-fallback") {
          sendStatus("loading", { detail: "CoreML unavailable; using the CPU…" });
        } else if (messages[event.phase]) {
          sendStatus("loading", { detail: messages[event.phase] });
        }
      },
    });
  } catch (error) {
    client.terminate();
    throw error;
  }
  if (shuttingDown) {
    client.terminate();
    return;
  }
  recognizer = client;
}

async function initRecorder() {
  recorder = new Recorder({
    binDir: paths.bin,
    command: config.recorder,
    log: (line) => log(line),
  });
  recorder.on("data", onAudio);
  recorder.on("error", handleRecorderError);
  recorder.on("permission", () => {
    if (shuttingDown) return;
    const detail = "waiting for microphone permission — look for a system prompt";
    sendStatus(phase, { detail });
  });
  recorder.on("ready", () => {
    if (shuttingDown) return;
    mic = "warm";
    scheduleWarmStop();
    if (phase === "idle") sendStatus("idle", { mic: "warm", detail: "" });
  });

  await recorder.init({
    onStatus: (event) => {
      if (shuttingDown) return;
      if (event.phase === "compiling") {
        sendStatus("loading", { detail: "building the microphone helper (one time)…" });
      }
    },
  });
}

/* ----------------------------------------------------------------- audio */

function onAudio(samples) {
  if (shuttingDown) return;
  ring.push({ samples, at: Date.now() });
  ringSamples += samples.length;
  const max = RING_SECONDS * SR;
  while (ring.length && ringSamples > max) ringSamples -= ring.shift().samples.length;

  if (phase === "recording" && recording) {
    recording.chunks.push(samples);
    const value = peak(samples) / 32768;
    if (value > recording.peak) recording.peak = value;
  }
}

function seedRecording(rec, preRollMs) {
  const cutoff = Date.now() - preRollMs;
  for (const item of ring) {
    if (item.at < cutoff) continue;
    rec.chunks.push(item.samples);
    const value = peak(item.samples) / 32768;
    if (value > rec.peak) rec.peak = value;
  }
}

function concatPcm(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return int16ToFloat32(out);
}

/* --------------------------------------------------------------- recorder */

function warmMic() {
  if (!recorder) return Promise.reject(new RecorderError("the microphone is unavailable", { code: "NO_RECORDER" }));
  if (recorder.isWarm) {
    mic = "warm";
    return Promise.resolve();
  }
  if (warmPromise) return warmPromise;
  mic = "warming";
  warmPromise = (async () => {
    try {
      await recorder.warm();
      if (shuttingDown) return;
      mic = "warm";
      scheduleWarmStop();
    } finally {
      warmPromise = null;
    }
  })();
  return warmPromise;
}

function scheduleWarmStop() {
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = null;
  if (shuttingDown) return;
  if (warmSeconds < 0) return; // keep the microphone open until released
  if (warmSeconds === 0) {
    stopMic().catch((error) => log("could not stop the microphone", error));
    return;
  }
  warmTimer = setTimeout(() => {
    warmTimer = null;
    stopMic().catch((error) => log("could not stop the microphone", error));
  }, warmSeconds * 1000);
}

async function stopMic() {
  if (shuttingDown) return;
  if (phase === "recording" || phase === "arming") return;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = null;
  if (!recorder || !recorder.isWarm) {
    mic = "cold";
    return;
  }
  await recorder.stop().catch(() => {});
  mic = "cold";
  sendStatus(phase, { mic: "cold" });
}

function handleRecorderError(error) {
  if (shuttingDown) return;
  log("microphone error", error);
  mic = "cold";
  recording = null;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = null;
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = null;
  const code = error?.code ?? "MIC";
  const message =
    code === "MIC_PERMISSION"
      ? "microphone access is off"
      : error?.message ?? "the microphone stopped";
  sendStatus("error", { code, message, mic: "cold" });
}

/* -------------------------------------------------------------- recording */

async function beginRecording() {
  if (!recognizer) {
    sendStatus("error", { code: "NOT_READY", message: "the recognizer is not ready", mic });
    return;
  }
  if (!recorder) {
    sendStatus("error", { code: "NO_RECORDER", message: "the microphone is unavailable", mic });
    return;
  }
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = null;

  const rec = { startedAt: Date.now(), chunks: [], peak: 0, canceled: false };
  recording = rec;
  const wasWarm = recorder.isWarm;
  sendStatus("arming", {
    mic: wasWarm ? "warm" : "warming",
    detail: wasWarm ? "" : "starting the microphone…",
  });

  try {
    await warmMic();
    if (rec.canceled || phase !== "arming" || shuttingDown) return;
    seedRecording(rec, wasWarm ? WARM_PRE_ROLL_MS : COLD_PRE_ROLL_MS);
    rec.startedAt = Date.now();
    phase = "recording";
    recording = rec;
    sendStatus("recording", { mic: "warm", detail: "" });
    if (maxTimer) clearTimeout(maxTimer);
    maxTimer = setTimeout(() => {
      maxTimer = null;
      if (phase === "recording") {
        log("five minute recording limit reached");
        stopRecording();
      }
    }, MAX_RECORDING_MS);
  } catch (error) {
    if (shuttingDown) return;
    recording = null;
    handleRecorderError(error);
  }
}

function stopRecording() {
  if (maxTimer) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
  if (phase === "arming") {
    if (recording) recording.canceled = true;
    recording = null;
    sendStatus("idle", {
      mic: recorder?.isWarm ? "warm" : "cold",
      detail: "canceled",
    });
    scheduleWarmStop();
    return;
  }
  if (phase !== "recording" || !recording) return;

  const rec = recording;
  const elapsed = Date.now() - rec.startedAt;
  const total = rec.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  if (elapsed < 250 || total < SR * 0.3) {
    recording = null;
    sendStatus("idle", { detail: "too short — hold the shortcut a little longer", mic: recorder?.isWarm ? "warm" : "cold" });
    scheduleWarmStop();
    return;
  }
  if (rec.peak < 0.0008) {
    recording = null;
    sendStatus("error", {
      code: "NO_AUDIO",
      message: "nothing came through — check the input device",
      mic: recorder?.isWarm ? "warm" : "cold",
    });
    scheduleWarmStop();
    return;
  }

  const pcm = concatPcm(rec.chunks);
  recording = null;
  sendStatus("transcribing", { mic: recorder?.isWarm ? "warm" : "cold" });
  transcribe(pcm).catch((error) => log("transcription failed", error));
}

async function transcribe(pcm) {
  try {
    const result = await recognizer.transcribe(pcm, {
      onProgress: (progress) => {
        if (shuttingDown) return;
        sendStatus("transcribing", {
          detail: progress.of > 1 ? `chunk ${progress.done} of ${progress.of}` : "",
          mic,
        });
      },
    });
    if (shuttingDown) return;

    const text = result.text.trim();
    if (!text) {
      sendStatus("idle", { detail: "didn't catch that — try again", mic });
      scheduleWarmStop();
      return;
    }

    const entry = {
      text,
      at: Date.now(),
      audioSec: result.audioSec,
      ms: result.totalMs,
      encodeMs: result.encodeMs,
      decodeMs: result.decodeMs,
      device: recognizer.device,
    };
    history = addHistory(history, entry, HISTORY_LIMIT);
    saveHistory(paths.history, history).catch((error) => log("could not save history", error));

    const copied = await copyToClipboard(text);
    if (!copied.ok) log("pbcopy failed; the menu bar will copy instead");

    send({ type: "last", text, audioSec: result.audioSec, ms: result.totalMs });
    sendStatus("idle", { mic, detail: "" });
    log(`transcribed ${result.audioSec.toFixed(2)}s in ${Math.round(result.totalMs)}ms`);
    scheduleWarmStop();
  } catch (error) {
    if (shuttingDown) return;
    log("transcription error", error);
    const code = error?.code ?? "TRANSCRIBE";
    const message = code === "EMPTY_AUDIO" ? "didn't catch that" : error?.message ?? "transcription failed";
    sendStatus("error", { code, message, mic });
    scheduleWarmStop();
  }
}

/* ------------------------------------------------------------------ input */

function toggle() {
  if (shuttingDown) return;
  if (phase === "starting" || phase === "loading") {
    pendingStart = !pendingStart;
    sendStatus(phase, {
      detail: pendingStart ? "will start recording when ready" : "canceled",
    });
    return;
  }
  if (phase === "recording" || phase === "arming") {
    stopRecording();
    return;
  }
  if (phase === "transcribing") return;
  if (phase === "error") {
    /* Let the next press retry. The common case is the user granting mic
     * permission after seeing the error. */
    phase = "idle";
    beginRecording().catch((error) => log("could not retry", error));
    return;
  }
  beginRecording().catch((error) => log("could not start", error));
}

function releaseMicrophone() {
  if (shuttingDown) return;
  if (phase === "recording" || phase === "arming") return;
  stopMic().catch((error) => log("could not release the microphone", error));
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = null;
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = null;
  modelAbort?.abort();
  recorder?.killNow();
  recognizer?.terminate();
  recognizer = null;
  setTimeout(() => process.exit(0), 20);
}

/* ------------------------------------------------------------------- boot */

history = config.history === false ? [] : await loadHistory(paths.history);

process.on("SIGUSR1", () => toggle());
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
  log("fatal", error);
  try {
    send({ type: "status", state: "error", mic: "cold", code: "FATAL", message: error?.message ?? String(error) });
  } catch {}
  shutdown();
});
process.on("unhandledRejection", (error) => {
  log("unhandled rejection", error);
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "toggle") toggle();
  else if (message.type === "releaseMic") releaseMicrophone();
  else if (message.type === "shutdown") shutdown();
});
input.on("close", shutdown);
process.stdin.on("end", shutdown);

log(`ready · home=${paths.root} · warm=${warmSeconds}s · recorder=${config.recorder ?? "default"}`);
init().catch((error) => {
  if (shuttingDown) return;
  log("init failed", error);
  sendStatus("error", { code: "INIT", message: error?.message ?? String(error), mic: "cold" });
});
