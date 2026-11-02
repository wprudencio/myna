/*
 * Audio file input for `myna file.wav`.
 *
 * Anything the system can decode is converted to 16 kHz mono PCM16 with
 * afconvert (macOS) or ffmpeg. Pure PCM16 WAVs that are already in the right
 * shape skip the conversion.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMac } from "./util.js";

function run(command, args, timeout = 120_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: "ENOENT", stderr: error.message });
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeout);
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: error.code ?? "ERROR", stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr });
    });
  });
}

export async function readPcm16Wav(path) {
  const buffer = await fs.readFile(path);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`unsupported WAV format (format ${fmt.format}, ${fmt.bits}-bit)`);
  }
  if (!fmt.channels || !fmt.sampleRate) throw new Error("WAV has an invalid format");
  if (fmt.sampleRate !== 16_000) {
    throw new Error(`WAV is ${fmt.sampleRate} Hz; expected 16 kHz`);
  }

  const frames = Math.floor(data.length / (2 * fmt.channels));
  if (!frames) throw new Error("WAV contains no samples");
  const samples = new Int16Array(frames);
  if (fmt.channels === 1) {
    for (let i = 0; i < frames; i++) samples[i] = data.readInt16LE(i * 2);
  } else {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let channel = 0; channel < fmt.channels; channel++) {
        sum += data.readInt16LE((i * fmt.channels + channel) * 2);
      }
      samples[i] = Math.round(sum / fmt.channels);
    }
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

export async function loadAudioFile(input) {
  /* Fast path: a 16 kHz mono PCM16 WAV needs no conversion. */
  try {
    const wav = await readPcm16Wav(input);
    return { samples: wav.samples, tempDir: null, converted: false };
  } catch {}

  const tempDir = await fs.mkdtemp(join(tmpdir(), "myna-"));
  const output = join(tempDir, "audio.wav");
  const attempts = [];
  if (isMac) {
    attempts.push({
      command: "afconvert",
      args: ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", input, output],
    });
  }
  attempts.push({
    command: "ffmpeg",
    args: ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output],
  });

  let lastError = "no audio converter available";
  for (const attempt of attempts) {
    const result = await run(attempt.command, attempt.args);
    if (result.ok) {
      const wav = await readPcm16Wav(output);
      return { samples: wav.samples, tempDir, converted: true };
    }
    lastError = `${attempt.command}: ${result.stderr.trim() || `exited ${result.code}`}`;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
  throw new Error(`could not decode ${input}\n${lastError}`);
}
