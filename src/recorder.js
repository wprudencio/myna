/*
 * Microphone capture.
 *
 * On macOS the preferred path is the tiny Swift helper in native/recorder.swift,
 * compiled once into the cache directory. It uses AVFoundation, streams 16 kHz
 * mono s16le on stdout, and starts in a few hundred milliseconds. On other
 * systems (or when swiftc is missing) we fall back to arecord / SoX / ffmpeg.
 * A custom command can be supplied with --recorder.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants, promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMac, isWindows, sleep } from "./util.js";

const SWIFT_SOURCE = fileURLToPath(new URL("../native/recorder.swift", import.meta.url));

export class RecorderError extends Error {
  constructor(message, { code = "RECORDER", detail = "" } = {}) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
    this.detail = detail;
  }
}

function which(command) {
  const finder = isWindows ? "where" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return null;
  return result.stdout.split("\n")[0].trim() || null;
}

function runProcess(command, args, { timeout = 0, env, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let aborted = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeout > 0) timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on("error", (error) => {
      cleanup();
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, aborted });
    });
    child.on("close", (code, sig) => {
      cleanup();
      resolve({ code, signal: sig, stdout, stderr, aborted });
    });
  });
}

async function compileHelper({ binDir, onStatus, signal }) {
  const version = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    throw new RecorderError("swiftc is not available", {
      code: "NO_SWIFT",
      detail: version.stderr || version.error?.message || "",
    });
  }

  const source = await fs.readFile(SWIFT_SOURCE, "utf8");
  const hash = createHash("sha1").update(version.stdout).update(source).digest("hex").slice(0, 12);
  const output = join(binDir, `myna-recorder-${hash}`);
  try {
    await fs.access(output, fsConstants.X_OK);
    return output;
  } catch {}

  await fs.mkdir(binDir, { recursive: true });
  /* A previous build may have been interrupted after spawning swiftc. */
  try {
    const prefix = `myna-recorder-${hash}.`;
    for (const name of await fs.readdir(binDir)) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        await fs.rm(join(binDir, name), { force: true }).catch(() => {});
      }
    }
  } catch {}
  const temp = `${output}.${process.pid}.tmp`;
  onStatus?.({ phase: "compiling" });
  const started = Date.now();
  const result = await runProcess("swiftc", ["-o", temp, SWIFT_SOURCE], {
    timeout: 240_000,
    signal,
  });
  if (result.aborted) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw new RecorderError("the microphone helper build was stopped", { code: "ABORTED" });
  }
  if (result.code !== 0) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw new RecorderError("could not build the microphone helper", {
      code: "COMPILE",
      detail: (result.stderr || result.stdout || "").trim().split("\n").slice(-8).join("\n"),
    });
  }
  await fs.chmod(temp, 0o755);
  await fs.rename(temp, output);
  onStatus?.({ phase: "compiled", ms: Date.now() - started });
  return output;
}

function detectCommand() {
  if (isMac) {
    if (which("sox")) {
      return {
        name: "SoX",
        command: "sox",
        args: ["-q", "-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
      };
    }
    if (which("ffmpeg")) {
      return {
        name: "ffmpeg",
        command: "ffmpeg",
        args: [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          "-f", "avfoundation", "-i", ":0",
          "-ar", "16000", "-ac", "1", "-f", "s16le", "-",
        ],
      };
    }
    return null;
  }

  if (isWindows) {
    if (which("ffmpeg")) {
      return {
        name: "ffmpeg",
        command: "ffmpeg",
        args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "dshow", "-i", "audio=default", "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
      };
    }
    return null;
  }

  if (which("arecord")) {
    return {
      name: "arecord",
      command: "arecord",
      args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"],
    };
  }
  if (which("sox")) {
    return {
      name: "SoX",
      command: "sox",
      args: ["-q", "-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
    };
  }
  if (which("ffmpeg")) {
    const backend = which("pactl") || which("wpctl") ? "pulse" : "alsa";
    return {
      name: "ffmpeg",
      command: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", backend, "-i", "default", "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
    };
  }
  return null;
}

function friendlyError(code, stderr) {
  if (code.includes("microphone-permission-denied")) {
    return new RecorderError("microphone access is off", { code: "MIC_PERMISSION", detail: stderr });
  }
  if (code.includes("no-audio-input")) {
    return new RecorderError("no microphone was found", { code: "NO_INPUT", detail: stderr });
  }
  if (code.includes("microphone-start-failed")) {
    return new RecorderError("the microphone could not start", { code: "MIC_START", detail: stderr });
  }
  return new RecorderError("the microphone stopped", { code: "RECORDER", detail: stderr });
}

export class Recorder extends EventEmitter {
  constructor({ binDir, command = null, cold = false, log = () => {} } = {}) {
    super();
    this.binDir = binDir;
    this.customCommand = command;
    this.cold = cold;
    this.log = log;
    this.child = null;
    this.ready = false;
    this.mode = null;
    this.helperPath = null;
    this.info = { name: "microphone", status: "unknown" };
    this.stderrLines = [];
    this.tail = Buffer.alloc(0);
    this.intentional = false;
    this.stopping = false;
    this.starting = null;
    this.initPromise = null;
    this.compileAbort = null;
    this.compileError = null;
    this.lastError = null;
    this.permissionRequested = false;
    this.on("error", (error) => {
      this.lastError = error;
    });
  }

  init(options = {}) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init(options).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async _init({ onStatus } = {}) {
    if (this.customCommand) {
      this.mode = "command";
      this.command = { name: "custom recorder", command: "/bin/sh", args: ["-c", this.customCommand] };
      this.info = { name: "custom recorder", status: "authorized" };
      this.log(`custom recorder: ${this.customCommand}`);
      return this.info;
    }

    if (isMac) {
      const bundled = process.env.MYNA_RECORDER_HELPER;
      if (bundled) {
        try {
          await fs.access(bundled, fsConstants.X_OK);
          this.helperPath = bundled;
          this.mode = "swift";
          this.log(`bundled microphone helper: ${bundled}`);
        } catch {}
      }
      if (!this.helperPath) {
        this.compileAbort = new AbortController();
        try {
          this.helperPath = await compileHelper({
            binDir: this.binDir,
            onStatus,
            signal: this.compileAbort.signal,
          });
          this.mode = "swift";
        } catch (error) {
          this.compileError = error;
        } finally {
          this.compileAbort = null;
        }
      }
    }

    if (!this.helperPath) {
      this.command = detectCommand();
      if (!this.command) {
        const detail = this.compileError?.detail || "";
        throw new RecorderError(
          isMac
            ? "could not build the microphone helper"
            : "no audio recorder found",
          {
            code: "NO_RECORDER",
            detail: detail
              ? `${detail}\n\nInstall the Xcode command line tools (xcode-select --install) or SoX (brew install sox).`
              : "Install SoX (brew install sox) or ffmpeg, or pass --recorder \"<command>\".",
          }
        );
      }
      this.mode = "command";
    }

    if (this.mode === "swift") {
      const result = await runProcess(this.helperPath, ["--info"], { timeout: 8_000 });
      if (result.code === 0) {
        try {
          this.info = JSON.parse(result.stdout.trim());
        } catch {}
      }
      if (!this.info.name) this.info.name = "microphone";
      if (!this.info.status) this.info.status = "unknown";
    } else {
      this.info = { name: this.command.name, status: "unknown" };
    }

    onStatus?.({
      phase: "ready",
      mode: this.mode,
      name: this.info.name,
      status: this.info.status,
      compileError: this.compileError?.message ?? null,
    });
    return this.info;
  }

  get permission() {
    return this.info?.status ?? "unknown";
  }

  get isWarm() {
    return Boolean(this.child && this.ready);
  }

  async warm({ timeoutMs } = {}) {
    if (this.ready && this.child) return;
    if (this.starting) return this.starting;

    this.intentional = false;
    this.stopping = false;
    this.tail = Buffer.alloc(0);
    this.stderrLines = [];
    this.permissionRequested = false;

    const target =
      this.mode === "swift"
        ? { command: this.helperPath, args: [] }
        : { command: this.command.command, args: this.command.args };

    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    this.child = child;
    this.ready = false;
    this.log(`spawn ${target.command} ${target.args.join(" ")}`);

    const wait = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new RecorderError("the microphone did not start", {
          code: "TIMEOUT",
          detail: this.stderrLines.join("\n"),
        });
        this._stopProcess();
        reject(error);
      }, timeoutMs ?? (this.permission === "notDetermined" ? 120_000 : 12_000));

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      this._warmReject = (error) => finish(error);
      this.once("_ready", () => finish());
    });

    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.on("data", (chunk) => this._onStderr(chunk));
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.ready = false;
      this.child = null;
      const wrapped = new RecorderError(`could not start the microphone: ${error.message}`, {
        code: "SPAWN",
      });
      this._warmReject?.(wrapped);
      this.emit("error", wrapped);
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      const wasReady = this.ready;
      this.ready = false;
      this.child = null;
      this.starting = null;
      if (this.intentional) {
        this.intentional = false;
        return;
      }
      const detail = this.stderrLines.join("\n");
      const error = friendlyError(detail, detail);
      this.log(`recorder exited code=${code} signal=${signal}: ${detail.split("\n").slice(-3).join(" | ")}`);
      if (!wasReady) this._warmReject?.(error);
      this.emit("error", error);
    });

    this.starting = wait.finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  _onStdout(chunk) {
    if (this.stopping) return;
    const joined = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const usable = joined.length - (joined.length % 2);
    this.tail = usable === joined.length ? Buffer.alloc(0) : Buffer.from(joined.subarray(usable));
    if (!usable) return;

    const samples = new Int16Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = joined.readInt16LE(i * 2);

    if (!this.ready) {
      this.ready = true;
      this.log(`first audio chunk (${samples.length} samples)`);
      if (this.info.status !== "authorized") this.info.status = "authorized";
      this.emit("_ready");
      this.emit("ready", { ...this.info, mode: this.mode });
    }
    this.emit("data", samples);
  }

  _onStderr(chunk) {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      this.stderrLines.push(line);
      if (this.stderrLines.length > 40) this.stderrLines.shift();
      if (line === "permission-request" && !this.permissionRequested) {
        this.permissionRequested = true;
        this.emit("permission");
      } else if (line.startsWith("device ") || line.startsWith("format ")) {
        this.emit("stderr", line);
      }
    }
  }

  async _stopProcess() {
    this.compileAbort?.abort();
    const child = this.child;
    if (!child) return;
    this.intentional = true;
    this.stopping = true;
    this.ready = false;
    try {
      child.kill("SIGINT");
    } catch {}
    for (let i = 0; i < 30; i++) {
      if (this.child !== child) return;
      await sleep(50);
    }
    if (this.child === child) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    await sleep(30);
  }

  async stop() {
    const child = this.child;
    await this._stopProcess();
    if (this.child === child) this.child = null;
    this.ready = false;
    this.tail = Buffer.alloc(0);
  }

  killNow() {
    this.intentional = true;
    this.stopping = true;
    this.ready = false;
    this.compileAbort?.abort();
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }

  async dispose() {
    await this.stop();
    this.removeAllListeners("data");
  }
}
