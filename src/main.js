/*
 * myna — push-to-talk speech to clipboard, entirely on this machine.
 *
 * The TUI is one screen: boot/progress, idle with history, recording,
 * transcribing, help and errors. Space is the universal toggle; terminals
 * that speak the kitty keyboard protocol also get true hold-Shift.
 */

import { stdin, stdout, stderr } from "node:process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { clamp, formatBytes, formatDuration, formatSpeed, int16ToFloat32, makeTheme, peak, rms, toDecibels } from "./util.js";
import { helpText, parseArgs, UsageError, VERSION } from "./args.js";
import { MODEL_FILES, ensureModel, resolveHome } from "./model.js";
import { EmptyAudioError, Recognizer } from "./asr.js";
import { RecognizerClient } from "./asr-client.js";
import { runDaemonCommand } from "./daemon-control.js";
import { Recorder, RecorderError } from "./recorder.js";
import { KeyReader } from "./keys.js";
import { Terminal } from "./terminal.js";
import { createLogger } from "./log.js";
import { addHistory, HISTORY_LIMIT, loadHistory, saveHistory } from "./history.js";
import { copyToClipboard, osc52 } from "./clipboard.js";
import { loadAudioFile } from "./wav.js";
import { render } from "./tui.js";

const SR = 16_000;
const WARM_IDLE_MS = 120_000;
const RING_SECONDS = 2;
const PRE_ROLL_MS = 250;
const MAX_RECORDING_MS = 300_000;

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "daemon") {
    process.exitCode = await runDaemonCommand(argv.slice(1));
    return;
  }

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`myna: ${error.message}\n\nRun myna --help for usage.\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (options.help) {
    stdout.write(`${helpText()}\n`);
    return;
  }
  if (options.version) {
    stdout.write(`myna ${VERSION}\n`);
    return;
  }

  const paths = resolveHome(options.home);
  const logger = createLogger(paths.log, options.debug);

  if (options.file) {
    try {
      await runFile(options, paths, logger);
    } catch (error) {
      logger.error(error);
      stderr.write(`myna: ${friendlyCliError(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write("myna: the interactive view needs a real terminal.\nUse --file <audio> to transcribe a file.\n");
    process.exitCode = 1;
    return;
  }

  await runTui(options, paths, logger);
}

/* ------------------------------------------------------------------ file -- */

async function runFile(options, paths, logger) {
  const tty = Boolean(stderr.isTTY);
  let current = "";

  const status = (text, force = false) => {
    if (tty) {
      current = text;
      stderr.write(`\r\x1b[K${text}`);
    } else if (force) {
      stderr.write(`myna: ${text}\n`);
    }
  };
  const clear = () => {
    if (tty && current) {
      stderr.write("\r\x1b[K");
      current = "";
    }
  };

  status("checking the weights…", true);
  let lastAt = Date.now();
  let lastSession = 0;
  let speed = 0;
  let lastPercent = -1;

  await ensureModel({
    paths,
    onProgress: (progress) => {
      const now = Date.now();
      const elapsed = (now - lastAt) / 1000;
      if (elapsed >= 0.25) {
        const delta = Math.max(0, progress.sessionBytes - lastSession);
        const instant = delta / elapsed;
        speed = speed > 0 ? speed * 0.65 + instant * 0.35 : instant;
        lastSession = progress.sessionBytes;
        lastAt = now;
      }
      const percent = progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0;
      if (tty) {
        status(
          `downloading weights · ${percent}% · ${formatBytes(progress.loaded)} / ${formatBytes(
            progress.total
          )}${speed > 0 ? ` · ${formatSpeed(speed)}` : ""}`
        );
      } else if (percent >= lastPercent + 25 || percent === 100) {
        status(`downloading weights · ${percent}% (${formatBytes(progress.loaded)} / ${formatBytes(progress.total)})`, true);
        lastPercent = percent;
      }
    },
    onStatus: (event) => {
      if (event.phase === "done") status("weights ready", true);
    },
  });
  clear();

  const recognizer = new Recognizer();
  const statusMessages = {
    vocab: "reading the vocabulary…",
    preprocessor: "opening the preprocessor…",
    decoder: "opening the decoder…",
    encoder: "opening the encoder…",
    warmup: "warming up the recognizer…",
  };
  await recognizer.load({
    modelDir: paths.models,
    ep: options.ep,
    threads: options.threads,
    onStatus: (event) => {
      if (event.phase === "encoder-fallback") status("CoreML unavailable; falling back to the CPU…", true);
      else if (statusMessages[event.phase]) status(statusMessages[event.phase], true);
    },
  });
  clear();

  status("decoding the audio…", true);
  let audio = null;
  try {
    audio = await loadAudioFile(options.file);
    clear();

    const pcm = int16ToFloat32(audio.samples);
    status(`transcribing ${formatDuration(pcm.length / SR)} of audio…`, true);
    const result = await recognizer.transcribe(pcm, {
      onProgress: (progress) => {
        if (progress.of > 1) status(`transcribing · chunk ${progress.done} / ${progress.of}…`, tty);
      },
    });
    clear();

    if (!result.text) {
      stderr.write("myna: no speech was recognized.\n");
      process.exitCode = 1;
      return;
    }

    let copied = false;
    if (options.copy) {
      const clipboard = await copyToClipboard(result.text);
      copied = clipboard.ok;
      if (!copied) {
        stderr.write("myna: could not reach the clipboard; the text is printed below.\n");
      }
    }

    if (options.json) {
      stdout.write(
        `${JSON.stringify(
          {
            text: result.text,
            file: options.file,
            audioSec: result.audioSec,
            chunks: result.chunks,
            encodeMs: result.encodeMs,
            decodeMs: result.decodeMs,
            totalMs: result.totalMs,
            device: recognizer.device,
            copied,
          },
          null,
          2
        )}\n`
      );
    } else {
      stdout.write(`${result.text}\n`);
    }
  } finally {
    clear();
    if (audio?.tempDir) await fs.rm(audio.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function friendlyCliError(error) {
  if (error instanceof RecorderError) return `${error.message}${error.detail ? `\n${error.detail}` : ""}`;
  return error?.message ?? String(error);
}

function displayPath(path) {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

/* ------------------------------------------------------------------- tui -- */

async function runTui(options, paths, logger) {
  const theme = makeTheme(options.color && stdout.isTTY);
  const terminal = new Terminal(stdout);
  const keys = new KeyReader(stdin, { kitty: options.kitty });
  const demo = options.demo;

  const state = {
    phase: "boot",
    version: VERSION,
    kitty: false,
    demo,
    paths: { root: displayPath(paths.root), models: displayPath(paths.models) },
    model: {
      state: demo ? "ready" : "checking",
      files: demo ? [] : MODEL_FILES.map((file) => ({ ...file, loaded: 0 })),
      loaded: demo ? 0 : 0,
      total: demo ? 0 : MODEL_FILES.reduce((sum, file) => sum + file.size, 0),
      sessionBytes: 0,
      speed: 0,
      activeFile: null,
      message: demo ? "" : "checking the cache…",
      device: demo ? "DEMO" : null,
      loadMs: 0,
      error: null,
    },
    mic: {
      state: demo ? "ready" : "preparing",
      name: demo ? "demo microphone" : "microphone",
      permission: demo ? "authorized" : "unknown",
      warm: demo,
      mode: demo ? "demo" : null,
      message: null,
      detail: null,
      compileError: null,
    },
    history: [],
    selected: 0,
    copy: options.copy ? null : { state: "off", index: 0 },
    toast: null,
    error: null,
    recording: null,
    transcribing: null,
    help: false,
  };

  if (options.history) {
    state.history = await loadHistory(paths.history);
  }

  let quitting = false;
  let dirty = true;
  let renderTimer = null;
  let warmTimer = null;
  let recorder = null;
  let recorderInit = null;
  let recognizer = null;
  let modelAbort = null;
  let modelAttempt = 0;
  let recognizerAttempt = 0;
  let warmPromise = null;
  let lastProgressAt = 0;
  let lastSessionBytes = 0;
  let lastSpace = 0;
  let shiftHeld = new Set();
  let shiftRecording = false;
  let ring = [];
  let ringSamples = 0;
  let lastDemoLevel = 0;
  let demoIndex = 0;
  let demoFinish = null;

  const schedule = () => {
    dirty = true;
  };

  const draw = () => {
    if (quitting) return;
    const { width, height } = terminal.size;
    terminal.draw(render(state, width, height, theme));
  };

  function showToast(text, tone = "info", ms = 2600) {
    if (quitting) return;
    state.toast = { text, tone, until: Date.now() + ms };
    schedule();
    setTimeout(() => {
      if (state.toast && state.toast.until <= Date.now()) {
        state.toast = null;
        schedule();
      }
    }, ms + 40);
  }

  function setPhase(phase) {
    state.phase = phase;
    schedule();
  }

  /* ----------------------------------------------------------- microphone */

  function onAudio(samples) {
    if (quitting) return;
    ring.push({ samples, at: Date.now() });
    ringSamples += samples.length;
    const max = RING_SECONDS * SR;
    while (ring.length && ringSamples > max) {
      ringSamples -= ring.shift().samples.length;
    }

    if (state.phase === "recording" && state.recording) {
      state.recording.chunks.push(samples);
      const value = rms(samples) / 32768;
      state.recording.levels.push(toDecibels(value));
      if (state.recording.levels.length > 240) state.recording.levels.shift();
      const chunkPeak = peak(samples) / 32768;
      if (chunkPeak > state.recording.peak) {
        state.recording.peak = chunkPeak;
        state.recording.peakDb = toDecibels(chunkPeak);
      }
      dirty = true;
    }
  }

  function seedRecording(rec) {
    const cutoff = Date.now() - PRE_ROLL_MS;
    for (const item of ring) {
      if (item.at < cutoff) continue;
      rec.chunks.push(item.samples);
      const value = rms(item.samples) / 32768;
      rec.levels.push(toDecibels(value));
      const chunkPeak = peak(item.samples) / 32768;
      if (chunkPeak > rec.peak) {
        rec.peak = chunkPeak;
        rec.peakDb = toDecibels(chunkPeak);
      }
    }
    if (rec.levels.length > 240) rec.levels = rec.levels.slice(-240);
  }

  function handleRecorderError(error) {
    logger.error(error);
    if (quitting) return;
    state.mic.warm = false;
    if (error?.code === "MIC_PERMISSION") {
      state.mic.state = "ready";
      state.mic.permission = "denied";
      state.mic.message = null;
      state.mic.detail = null;
    } else {
      state.mic.state = "error";
      state.mic.message = error?.message ?? "the microphone stopped";
      state.mic.detail = error?.detail ?? null;
    }
    if (state.phase === "recording") {
      stopRecording("error");
    } else if (state.phase === "arming") {
      state.recording = null;
      setPhase("idle");
      showToast(error?.message ?? "the microphone stopped", "error", 3500);
    }
    schedule();
  }

  function setupRecorder() {
    if (demo) return Promise.resolve();
    recorder = new Recorder({
      binDir: paths.bin,
      command: options.recorder,
      cold: options.cold,
      log: (line) => logger.log(line),
    });
    recorder.on("data", onAudio);
    recorder.on("error", handleRecorderError);
    recorder.on("permission", () => {
      state.mic.message = "waiting for microphone permission — look for a system prompt";
      schedule();
    });
    recorder.on("ready", (info) => {
      if (quitting) return;
      state.mic.state = "ready";
      state.mic.name = info.name ?? "microphone";
      state.mic.permission = info.status === "notDetermined" ? "authorized" : info.status;
      state.mic.mode = info.mode ?? recorder.mode;
      state.mic.warm = true;
      state.mic.message = null;
      scheduleWarmStop();
      schedule();
    });

    recorderInit = initRecorder();
    return recorderInit;
  }

  async function initRecorder() {
    state.mic.state = "preparing";
    state.mic.message = "building the microphone helper (one time)…";
    schedule();
    try {
      const info = await recorder.init({
        onStatus: (event) => {
          if (event.phase === "compiling") {
            state.mic.message = "building the microphone helper (one time)…";
          } else if (event.phase === "compiled") {
            state.mic.message = "microphone helper ready";
          } else if (event.phase === "ready") {
            state.mic.name = event.name ?? state.mic.name;
            state.mic.permission = event.status ?? state.mic.permission;
            state.mic.mode = event.mode ?? null;
          }
          schedule();
        },
      });
      state.mic.state = "ready";
      state.mic.name = info.name ?? "microphone";
      state.mic.permission = info.status ?? "unknown";
      state.mic.mode = recorder.mode;
      state.mic.compileError = recorder.compileError?.message ?? null;
      state.mic.message = null;
      schedule();
      if (info.status === "authorized" && !options.cold) {
        warmMic().catch(() => {});
      }
    } catch (error) {
      state.mic.state = "error";
      state.mic.message = error.message;
      state.mic.detail = error.detail ?? null;
      logger.error(error);
      schedule();
      throw error;
    }
  }

  function scheduleWarmStop() {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = null;
    if (quitting || demo || options.cold || options.warm) return;
    warmTimer = setTimeout(async () => {
      warmTimer = null;
      if (quitting) return;
      if (state.phase === "recording" || state.phase === "arming") return;
      if (!recorder || !state.mic.warm) return;
      await recorder.stop().catch(() => {});
      state.mic.warm = false;
      schedule();
    }, WARM_IDLE_MS);
  }

  function warmMic() {
    if (demo) return Promise.resolve();
    if (!recorder) return Promise.reject(new RecorderError("no microphone"));
    if (recorder.isWarm) {
      state.mic.warm = true;
      return Promise.resolve();
    }
    if (warmPromise) return warmPromise;

    if (state.mic.permission === "notDetermined") {
      state.mic.message = "waiting for microphone permission — look for a system prompt";
    }
    state.mic.warm = false;
    schedule();

    warmPromise = (async () => {
      try {
        await recorder.warm();
        if (quitting) return;
        state.mic.warm = true;
        state.mic.state = "ready";
        state.mic.permission = recorder.info.status;
        state.mic.message = null;
        scheduleWarmStop();
        schedule();
      } finally {
        warmPromise = null;
        schedule();
      }
    })();
    return warmPromise;
  }

  async function recheckMic() {
    if (demo) return;
    if (!recorder) {
      setupRecorder().catch(() => {});
      return;
    }
    showToast("checking the microphone…", "info", 1400);
    state.mic.state = "preparing";
    state.mic.message = "checking the microphone…";
    schedule();
    try {
      const info = await recorder.init({
        onStatus: () => schedule(),
      });
      state.mic.state = "ready";
      state.mic.name = info.name ?? "microphone";
      state.mic.permission = info.status ?? "unknown";
      state.mic.message = null;
      state.mic.detail = null;
      state.mic.compileError = recorder.compileError?.message ?? null;
      state.mic.mode = recorder.mode;
      schedule();
      if (info.status === "authorized") {
        await warmMic();
      }
    } catch (error) {
      handleRecorderError(error);
    }
  }

  /* ----------------------------------------------------------- recording */

  function beginRecording(source) {
    if (demo) return beginDemoRecording(source);
    if (state.phase !== "idle") {
      if (state.phase === "transcribing") showToast("still transcribing…", "info", 1600);
      else if (state.phase === "boot") showToast("still preparing…", "info", 1600);
      return;
    }
    if (state.model.state !== "ready" || !recognizer) {
      showToast("the recognizer is still loading…", "info", 1800);
      return;
    }
    if (state.mic.state === "error") {
      showToast(state.mic.message ?? "the microphone is unavailable", "error", 3200);
      return;
    }
    if (state.mic.permission === "denied" || state.mic.permission === "restricted") {
      showToast("microphone permission is off — press r to check", "error", 3200);
      return;
    }

    if (warmTimer) {
      clearTimeout(warmTimer);
      warmTimer = null;
    }
    state.help = false;
    state.copy = options.copy ? state.copy : { state: "off", index: state.selected };
    const rec = {
      source,
      startedAt: Date.now(),
      chunks: [],
      levels: [],
      peak: 0,
      peakDb: -60,
      canceled: false,
    };
    state.recording = rec;

    if (recorder && recorder.isWarm) {
      seedRecording(rec);
      setPhase("recording");
      return;
    }

    setPhase("arming");
    (async () => {
      try {
        if (!recorder || !recorder.mode) {
          if (recorderInit) await recorderInit;
        }
        if (rec.canceled || quitting) return;
        await warmMic();
        if (rec.canceled || quitting) return;
        seedRecording(rec);
        rec.startedAt = Date.now();
        setPhase("recording");
      } catch (error) {
        if (quitting) return;
        state.recording = null;
        setPhase("idle");
        const message =
          error?.code === "MIC_PERMISSION"
            ? "microphone permission is off — press r to check"
            : error?.message ?? "the microphone did not start";
        showToast(message, "error", 4000);
      }
    })();
  }

  function stopRecording(source) {
    if (demo) return stopDemoRecording(source);
    if (state.phase === "arming") {
      if (state.recording) state.recording.canceled = true;
      state.recording = null;
      setPhase("idle");
      showToast("the microphone was still starting — try again", "info", 3000);
      return;
    }
    if (state.phase !== "recording" || !state.recording) return;

    const rec = state.recording;
    const elapsed = Date.now() - rec.startedAt;
    const total = rec.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    if (elapsed < 250 || total < SR * 0.3) {
      state.recording = null;
      setPhase("idle");
      showToast("too short — hold the key a little longer", "info", 2600);
      scheduleWarmStop();
      return;
    }
    if (rec.peak < 0.0008) {
      state.recording = null;
      setPhase("idle");
      showToast("nothing came through — check the input device", "error", 4200);
      scheduleWarmStop();
      return;
    }

    const pcm = concatPcm(rec.chunks);
    state.recording = null;
    state.transcribing = {
      startedAt: Date.now(),
      levels: rec.levels,
      peakDb: rec.peakDb,
      done: 0,
      of: Math.max(1, Math.ceil(pcm.length / (SR * 30))),
      partialText: "",
      encodeMs: 0,
      decodeMs: 0,
    };
    setPhase("transcribing");

    if (options.cold && recorder) {
      recorder
        .stop()
        .catch(() => {})
        .finally(() => {
          state.mic.warm = false;
          schedule();
        });
    }

    runTranscription(pcm).catch((error) => {
      if (quitting) return;
      logger.error(error);
    });
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

  function cancelRecording(reason) {
    if (state.phase !== "recording" && state.phase !== "arming") return;
    if (state.recording) state.recording.canceled = true;
    state.recording = null;
    setPhase("idle");
    if (reason) showToast(reason, "info", 2200);
    scheduleWarmStop();
  }

  async function runTranscription(pcm) {
    try {
      const result = await recognizer.transcribe(pcm, {
        onProgress: (progress) => {
          if (!state.transcribing) return;
          state.transcribing.done = progress.done;
          state.transcribing.of = progress.of;
          state.transcribing.partialText = progress.text;
          state.transcribing.encodeMs = progress.encodeMs;
          state.transcribing.decodeMs = progress.decodeMs;
          schedule();
        },
      });
      if (quitting) return;
      const text = result.text.trim();
      if (!text) {
        state.transcribing = null;
        setPhase("idle");
        showToast("didn't catch that — try again", "info", 3000);
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
      state.history = addHistory(state.history, entry, HISTORY_LIMIT);
      state.selected = 0;
      state.transcribing = null;
      setPhase("idle");
      logger.log(`transcribed ${result.audioSec.toFixed(2)}s audio in ${Math.round(result.totalMs)}ms (${recognizer.device})`);
      if (options.history) saveHistory(paths.history, state.history).catch((error) => logger.error(error));

      if (options.copy) await copyEntry(entry, 0, true);
      else {
        state.copy = { state: "off", index: 0 };
        schedule();
      }
      scheduleWarmStop();
    } catch (error) {
      if (quitting) return;
      logger.error(error);
      state.transcribing = null;
      if (error?.code === "STOPPED") return;
      if (error instanceof EmptyAudioError || error?.code === "EMPTY_AUDIO") {
        setPhase("idle");
        showToast("didn't catch that — try again", "info", 3000);
      } else {
        state.error = {
          title: "TRANSCRIPTION FAILED",
          message: error?.message ?? String(error),
          hint: "Press r to reload the recognizer, or q to quit. Run with --debug for a log.",
          retry: "recognizer",
        };
        setPhase("error");
      }
      scheduleWarmStop();
    }
  }

  async function copyEntry(entry, index, automatic = false) {
    if (quitting) return;
    const result = await copyToClipboard(entry.text);
    if (quitting) return;
    if (result.ok) {
      state.copy = { state: "ok", method: "clipboard", index };
      showToast(automatic ? "copied to clipboard" : "copied again", "ok", 2400);
    } else {
      terminal.raw(osc52(entry.text));
      state.copy = { state: "ok", method: "terminal", index };
      showToast("sent to the terminal clipboard", "info", 3000);
    }
    schedule();
  }

  function copySelected() {
    if (state.phase !== "idle" || !state.history.length) return;
    const index = clamp(state.selected, 0, state.history.length - 1);
    const entry = state.history[index];
    copyEntry(entry, index, false).catch((error) => {
      logger.error(error);
      if (!quitting) showToast("could not copy", "error", 2600);
    });
  }

  function select(delta) {
    if (state.phase !== "idle" || !state.history.length) return;
    state.selected = clamp(state.selected + delta, 0, state.history.length - 1);
    schedule();
  }

  /* --------------------------------------------------------------- demo -- */

  const DEMO_TRANSCRIPTS = [
    "Ship the release notes before Friday, and mention the new push-to-talk mode.",
    "Remind me to call the dentist tomorrow morning, and to pick up the dry cleaning after lunch.",
    "The migration is done. All twelve services are on the new queue and the error rate is back to normal.",
    "Take the train at seven forty, then walk from the station to the office on Avenida da Liberdade.",
    "Please add a note to the ticket: the login page needs a better empty state and a proper retry button.",
  ];

  function beginDemoRecording(source) {
    if (state.phase !== "idle") {
      if (state.phase === "transcribing") showToast("still transcribing…", "info", 1500);
      return;
    }
    state.help = false;
    state.recording = {
      source,
      startedAt: Date.now(),
      chunks: [],
      levels: [],
      peak: 0,
      peakDb: -1,
      demo: true,
    };
    lastDemoLevel = 0;
    setPhase("recording");
  }

  function stopDemoRecording() {
    if (state.phase !== "recording" || !state.recording) return;
    const rec = state.recording;
    if (Date.now() - rec.startedAt < 300) {
      state.recording = null;
      setPhase("idle");
      showToast("too short — hold the key a little longer", "info", 2200);
      return;
    }
    state.recording = null;
    state.transcribing = {
      startedAt: Date.now(),
      levels: rec.levels,
      peakDb: rec.peakDb,
      done: 0,
      of: 1,
      partialText: "",
      encodeMs: 0,
      decodeMs: 0,
    };
    setPhase("transcribing");
    const started = Date.now();
    demoFinish = setTimeout(() => {
      demoFinish = null;
      if (quitting) return;
      const text = DEMO_TRANSCRIPTS[demoIndex++ % DEMO_TRANSCRIPTS.length];
      const entry = {
        text,
        at: Date.now(),
        audioSec: (Date.now() - rec.startedAt) / 1000,
        ms: Date.now() - started + 380,
        encodeMs: 380,
        decodeMs: 120,
        device: "DEMO",
      };
      state.history = addHistory(state.history, entry, HISTORY_LIMIT);
      state.selected = 0;
      state.transcribing = null;
      setPhase("idle");
      if (options.copy) copyEntry(entry, 0, true).catch(() => {});
      else {
        state.copy = { state: "off", index: 0 };
        showToast("demo transcript — nothing was recorded", "info", 3000);
      }
      schedule();
    }, 900);
  }

  function demoLevels() {
    if (!state.recording?.demo) return;
    const now = Date.now();
    if (now - lastDemoLevel < 65) return;
    lastDemoLevel = now;
    const elapsed = (now - state.recording.startedAt) / 1000;
    const db = -34 + 14 * Math.sin(elapsed * 5.3) + 7 * Math.sin(elapsed * 11.7 + 1.4) + (Math.random() * 6 - 3);
    const value = clamp(db, -56, -1);
    state.recording.levels.push(value);
    if (state.recording.levels.length > 240) state.recording.levels.shift();
    state.recording.peakDb = Math.max(state.recording.peakDb, value);
    dirty = true;
  }

  /* --------------------------------------------------------------- model -- */

  function startModel() {
    if (quitting) return;
    const attempt = ++modelAttempt;
    if (modelAbort) modelAbort.abort();
    modelAbort = new AbortController();
    const signal = modelAbort.signal;

    state.model.state = "checking";
    state.model.message = "checking the cache…";
    state.model.error = null;
    state.model.loaded = 0;
    state.model.sessionBytes = 0;
    state.model.speed = 0;
    state.model.activeFile = null;
    state.model.files = MODEL_FILES.map((file) => ({ ...file, loaded: 0 }));
    state.error = null;
    state.phase = "boot";
    lastProgressAt = Date.now();
    lastSessionBytes = 0;
    schedule();

    ensureModel({
      paths,
      signal,
      onProgress: (progress) => {
        if (attempt !== modelAttempt || quitting) return;
        state.model.state = "downloading";
        state.model.loaded = progress.loaded;
        state.model.total = progress.total;
        state.model.sessionBytes = progress.sessionBytes;
        state.model.activeFile = progress.activeFile;
        state.model.files = progress.files.map((file) => ({ ...file }));
        const now = Date.now();
        if (now - lastProgressAt >= 200) {
          const elapsed = (now - lastProgressAt) / 1000;
          const delta = Math.max(0, progress.sessionBytes - lastSessionBytes);
          const instant = delta / elapsed;
          state.model.speed = state.model.speed > 0 ? state.model.speed * 0.65 + instant * 0.35 : instant;
          lastProgressAt = now;
          lastSessionBytes = progress.sessionBytes;
        }
        dirty = true;
      },
      onStatus: (event) => {
        if (attempt !== modelAttempt || quitting) return;
        if (event.phase === "done") {
          state.model.state = "loading";
          state.model.message = "opening the recognizer…";
          state.model.speed = 0;
          schedule();
          loadRecognizer(attempt);
        } else if (event.phase === "file-start") {
          state.model.message = event.resumed ? "resuming the download…" : "downloading the weights…";
        }
        schedule();
      },
    }).catch((error) => {
      if (attempt !== modelAttempt || quitting || signal.aborted) return;
      logger.error(error);
      state.model.state = "error";
      state.model.error = error.message;
      state.error = {
        title: "DOWNLOAD FAILED",
        message: error.message,
        hint: "Press r to resume. Files that finished are kept, and partial ranges are checked.",
        retry: "download",
      };
      setPhase("error");
    });
  }

  async function loadRecognizer(attempt = modelAttempt) {
    if (quitting) return;
    const id = ++recognizerAttempt;
    state.model.state = "loading";
    state.model.message = "reading the vocabulary…";
    schedule();

    if (recognizer) {
      recognizer.terminate();
      recognizer = null;
    }

    const client = new RecognizerClient({ log: (line) => logger.log(line) });
    try {
      await client.load({
        modelDir: paths.models,
        ep: options.ep,
        threads: options.threads,
        onStatus: (event) => {
          if (id !== recognizerAttempt || quitting) return;
          const messages = {
            vocab: "reading the vocabulary…",
            preprocessor: "opening the preprocessor…",
            decoder: "opening the decoder…",
            encoder: "opening the encoder…",
            warmup: "warming up the recognizer…",
            "warmup-error": "warmup failed; continuing…",
          };
          if (event.phase === "encoder-fallback") {
            state.model.message = "CoreML unavailable; falling back to the CPU…";
          } else if (messages[event.phase]) {
            state.model.message = messages[event.phase];
          }
          schedule();
        },
      });
      if (id !== recognizerAttempt || quitting || attempt !== modelAttempt) {
        client.terminate();
        return;
      }
      recognizer = client;
      state.model.state = "ready";
      state.model.device = client.device;
      state.model.loadMs = client.loadMs;
      state.model.message = "";
      if (state.phase === "boot") state.phase = "idle";
      logger.log(
        `recognizer ready · ${client.device} · load ${Math.round(client.loadMs)}ms · warmup ${Math.round(
          client.warmupMs
        )}ms`
      );
      schedule();
    } catch (error) {
      client.terminate();
      if (id !== recognizerAttempt || quitting) return;
      logger.error(error);
      state.model.state = "error";
      state.model.error = error.message;
      state.error = {
        title: "RECOGNIZER FAILED",
        message: error.message,
        hint: "Press r to try again. If it keeps failing, remove ~/.myna/models and restart.",
        retry: "recognizer",
      };
      setPhase("error");
    }
  }

  function retry() {
    if (state.phase === "error" && state.error?.retry) {
      const kind = state.error.retry;
      state.error = null;
      state.help = false;
      if (kind === "download") startModel();
      else if (kind === "recognizer") loadRecognizer();
      else if (kind === "mic") recheckMic();
      return;
    }
    if (state.phase === "idle" && (state.mic.permission === "denied" || state.mic.state === "error")) {
      recheckMic();
    }
  }

  /* --------------------------------------------------------------- keys -- */

  function cancelShiftChord() {
    if (!shiftRecording) return;
    shiftRecording = false;
    if (state.phase === "recording" || state.phase === "arming") cancelRecording(null);
  }

  keys.on("kitty", (supported) => {
    state.kitty = supported;
    schedule();
  });
  keys.on("ctrl-c", () => quit(0));
  keys.on("escape", () => {
    if (state.help) {
      state.help = false;
      schedule();
      return;
    }
    if (shiftRecording) cancelShiftChord();
    if (state.phase === "recording" || state.phase === "arming") cancelRecording("canceled");
  });
  keys.on("space", ({ event, mods = {} }) => {
    if (event !== 1) return;
    if (mods.ctrl || mods.alt || mods.super) return;
    if (state.help) {
      state.help = false;
      schedule();
      return;
    }
    if (shiftRecording || shiftHeld.size) {
      cancelShiftChord();
      return;
    }
    const now = Date.now();
    if (now - lastSpace < 300) return;
    lastSpace = now;
    if (state.phase === "recording" && state.recording?.source === "space") {
      stopRecording("space");
    } else if (state.phase === "idle") {
      beginRecording("space");
    } else if (state.phase === "arming") {
      cancelRecording("canceled");
    } else if (state.phase === "transcribing") {
      showToast("still transcribing…", "info", 1600);
    }
  });
  keys.on("shift", ({ event, side }) => {
    if (event === 3) {
      shiftHeld.delete(side);
      if (shiftHeld.size === 0) {
        if (shiftRecording) {
          shiftRecording = false;
          if (state.phase === "recording" || state.phase === "arming") stopRecording("shift");
        }
      } else if (!shiftHeld.has("left") && !shiftHeld.has("right")) {
        shiftHeld.clear();
      }
      return;
    }
    if (event === 2) return;
    if (state.help) return;
    shiftHeld.add(side);
    if (shiftHeld.size > 1) return;
    if (state.phase === "idle") {
      shiftRecording = true;
      beginRecording("shift");
    }
  });
  keys.on("modifier", ({ event, name }) => {
    if (event === 3) return;
    if (shiftRecording && name !== "shift") cancelShiftChord();
  });
  keys.on("enter", () => {
    if (state.help) {
      state.help = false;
      schedule();
      return;
    }
    if (shiftRecording) cancelShiftChord();
    copySelected();
  });
  keys.on("up", () => {
    if (state.help) {
      state.help = false;
      schedule();
      return;
    }
    if (shiftRecording) cancelShiftChord();
    select(1);
  });
  keys.on("down", () => {
    if (state.help) {
      state.help = false;
      schedule();
      return;
    }
    if (shiftRecording) cancelShiftChord();
    select(-1);
  });
  keys.on("char", ({ value, event, mods = {} }) => {
    if (event === 2) return;
    if (mods.ctrl || mods.alt || mods.super) return;
    if (state.help) {
      state.help = false;
      schedule();
      return;
    }
    if (shiftRecording) cancelShiftChord();
    if (value === "q") quit(0);
    else if (value === "?") {
      if (state.phase !== "recording" && state.phase !== "arming") {
        state.help = true;
        schedule();
      }
    } else if (value === "r") retry();
    else if (value === "c") copySelected();
  });

  /* --------------------------------------------------------------- quit -- */

  function quit(code = 0) {
    if (quitting) return;
    quitting = true;
    if (demoFinish) clearTimeout(demoFinish);
    if (renderTimer) clearInterval(renderTimer);
    if (warmTimer) clearTimeout(warmTimer);
    modelAbort?.abort();
    try {
      keys.destroy();
    } catch {}
    terminal.leave();
    if (recorder) recorder.killNow();
    if (recognizer) recognizer.terminate();
    setTimeout(() => process.exit(code), 150);
  }

  const onResize = () => schedule();
  stdout.on("resize", onResize);
  process.on("SIGWINCH", onResize);
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(130));

  const fatal = (error) => {
    logger.error(error);
    if (quitting) return;
    quitting = true;
    if (renderTimer) clearInterval(renderTimer);
    try {
      keys.destroy();
    } catch {}
    terminal.leave();
    if (recorder) recorder.killNow();
    if (recognizer) recognizer.terminate();
    stderr.write(`\nmyna: ${error?.stack ?? error}\n`);
    setTimeout(() => process.exit(1), 60);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);

  /* --------------------------------------------------------------- start -- */

  terminal.enter();
  try {
    await keys.start();
  } catch (error) {
    terminal.leave();
    throw error;
  }
  state.kitty = keys.kitty;
  draw();

  renderTimer = setInterval(() => {
    if (quitting) return;
    if (demo && state.phase === "recording") demoLevels();
    if (state.phase === "recording" && state.recording && Date.now() - state.recording.startedAt > MAX_RECORDING_MS) {
      stopRecording("limit");
      showToast("five minute limit reached", "info", 3000);
    }
    const animated =
      state.phase === "recording" ||
      state.phase === "arming" ||
      state.phase === "transcribing" ||
      state.model.state === "checking" ||
      state.model.state === "downloading" ||
      state.model.state === "loading" ||
      state.mic.state === "preparing";
    if (dirty || animated) {
      dirty = false;
      draw();
    }
  }, 40);

  if (demo) {
    setPhase("idle");
    schedule();
    return;
  }

  setupRecorder().catch(() => {});
  startModel();
}
