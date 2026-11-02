/*
 * Parakeet Redux (TDT) in Node, using onnxruntime-node.
 *
 *   waveforms [1,N] @16 kHz
 *     -> preprocessor.onnx  -> features [1,128,T]
 *     -> encoder-model.onnx -> encoder_outputs [1,1024,T/8]
 *     -> decoder_joint      -> greedy TDT loop, one 80 ms frame at a time
 *
 * The decoding recipe is the one from tts-realtime/stt-worker.js: the joint
 * network emits 8193 token logits plus 5 duration logits, and the winning
 * duration advances the frame pointer. Long recordings are cut near the
 * quietest point inside a 20–30 s window.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ort from "onnxruntime-node";

ort.env.logLevel = "error";

const SR = 16_000;
const FRAME_SEC = 0.08;
const BLANK = 8192;
const VOCAB = 8193;
const DURATIONS = [0, 1, 2, 3, 4];
const MAX_SYMBOLS = 10;
const CHUNK_SEC = 30;
const SKIP = new Set(["<unk>", "<pad>", "<blk>"]);

export const MODEL_NAMES = {
  pre: "preprocessor.onnx",
  encoder: "encoder-model.onnx",
  decoder: "decoder_joint-model.int8.onnx",
  vocab: "vocab.txt",
};

export class EmptyAudioError extends Error {
  constructor(message = "didn't catch any speech") {
    super(message);
    this.name = "EmptyAudioError";
    this.code = "EMPTY_AUDIO";
  }
}

/* ------------------------------------------------------------ audio in -- */

/* Cut the quiet head and tail, then lift a quiet recording towards full
 * scale. A fixed threshold would eat quiet microphones, so the gate follows
 * the clip's own peak. */
export function prepareAudio(pcm) {
  if (!pcm || pcm.length < SR * 0.2) return null;

  let overallPeak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]);
    if (abs > overallPeak) overallPeak = abs;
  }
  if (overallPeak < 0.0008) return null;

  const window = 320; // 20 ms
  const frames = Math.floor(pcm.length / window);
  if (frames < 2) return null;
  const threshold = Math.max(0.0012, Math.min(0.02, overallPeak * 0.03));

  let first = -1;
  let last = -1;
  for (let frame = 0; frame < frames; frame++) {
    let energy = 0;
    const start = frame * window;
    for (let i = 0; i < window; i++) {
      const value = pcm[start + i];
      energy += value * value;
    }
    if (Math.sqrt(energy / window) > threshold) {
      if (first < 0) first = frame;
      last = frame;
    }
  }
  if (first < 0) return null;

  const pad = Math.round(0.15 * SR);
  const start = Math.max(0, first * window - pad);
  const end = Math.min(pcm.length, (last + 1) * window + pad);
  if (end - start < SR * 0.25) return null;

  const out = pcm.slice(start, end);
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const abs = Math.abs(out[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0.001) {
    const gain = Math.min(8, 0.92 / peak);
    if (gain > 1.05) {
      for (let i = 0; i < out.length; i++) out[i] *= gain;
    }
  }
  return out;
}

/* Long audio is cut near the quietest moment inside the 20–30 s window. */
export function chunkRanges(pcm) {
  const cap = CHUNK_SEC * SR;
  if (pcm.length <= cap) return [[0, pcm.length]];

  const out = [];
  let start = 0;
  const window = SR / 10;
  while (pcm.length - start > cap) {
    let bestEnergy = Infinity;
    let bestIndex = start + cap;
    for (let i = start + 20 * SR; i + window <= start + cap; i += window / 2) {
      let energy = 0;
      for (let j = i; j < i + window; j++) energy += pcm[j] * pcm[j];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestIndex = i + window / 2;
      }
    }
    out.push([start, bestIndex]);
    start = bestIndex;
  }
  if (pcm.length - start > SR * 0.05) out.push([start, pcm.length]);
  return out;
}

/* ------------------------------------------------------------- recognizer */

export class Recognizer {
  constructor() {
    this.sessions = null;
    this.vocab = [];
    this.device = "cpu";
    this.loadMs = 0;
    this.warmupMs = 0;
    this.dims = null;
  }

  get ready() {
    return Boolean(this.sessions);
  }

  async load({ modelDir, ep = "auto", threads = 0, onStatus } = {}) {
    const started = performance.now();
    onStatus?.({ phase: "vocab" });
    const vocab = await readVocab(join(modelDir, MODEL_NAMES.vocab));

    const options = {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    };
    if (threads > 0) {
      options.intraOpNumThreads = threads;
      options.interOpNumThreads = threads;
    }

    onStatus?.({ phase: "preprocessor" });
    const pre = await ort.InferenceSession.create(join(modelDir, MODEL_NAMES.pre), options);
    onStatus?.({ phase: "decoder" });
    const decoder = await ort.InferenceSession.create(join(modelDir, MODEL_NAMES.decoder), options);

    let encoder = null;
    let device = "CPU";

    /* CoreML is opt-in. On some Macs and ONNX Runtime builds it compiles but
     * then fails at execution time, which would otherwise leave a broken
     * session. Run a tiny clip through it before accepting it. */
    if (ep === "coreml") {
      let coreml = null;
      onStatus?.({ phase: "encoder", ep: "coreml" });
      try {
        coreml = await ort.InferenceSession.create(join(modelDir, MODEL_NAMES.encoder), {
          ...options,
          executionProviders: ["coreml"],
        });
        this.sessions = { pre, encoder: coreml, decoder };
        this.vocab = vocab;
        const probe = await this.encode(new Float32Array(SR));
        await this.greedy(probe);
        encoder = coreml;
        device = "CoreML";
        this.sessions = null;
      } catch (error) {
        this.sessions = null;
        try {
          await coreml?.release?.();
        } catch {}
        onStatus?.({ phase: "encoder-fallback", message: error.message });
      }
    }

    if (!encoder) {
      onStatus?.({ phase: "encoder", ep: "cpu" });
      encoder = await ort.InferenceSession.create(join(modelDir, MODEL_NAMES.encoder), options);
      device = "CPU";
    }

    this.sessions = { pre, encoder, decoder };
    this.vocab = vocab;
    this.device = device;
    this.loadMs = performance.now() - started;

    /* Pay for the first graph compilation and the lazy decoder setup now,
     * while the user is still reading the screen. */
    onStatus?.({ phase: "warmup" });
    const warmStarted = performance.now();
    try {
      const encoded = await this.encode(new Float32Array(SR));
      await this.greedy(encoded);
    } catch (error) {
      onStatus?.({ phase: "warmup-error", message: error.message });
    }
    this.warmupMs = performance.now() - warmStarted;

    onStatus?.({
      phase: "ready",
      device: this.device,
      loadMs: this.loadMs,
      warmupMs: this.warmupMs,
      inputs: this.sessions.encoder.inputNames,
      outputs: this.sessions.encoder.outputNames,
    });
    return this;
  }

  async encode(pcm) {
    const { pre, encoder } = this.sessions;
    const waveforms = new ort.Tensor("float32", pcm, [1, pcm.length]);
    const lengths = new ort.Tensor("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]);

    const features = await pre.run({ waveforms, waveforms_lens: lengths });
    const mel = features[pre.outputNames[0]];
    const melLength = features[pre.outputNames[1]];

    const encoded = await encoder.run({ audio_signal: mel, length: melLength });
    const output = encoded[encoder.outputNames[0]];
    const outputLengths = encoded[encoder.outputNames[1]];
    const dims = output.dims;
    this.dims = dims;

    const [, dim, frames] = dims;
    const frameCount = Math.min(Number(outputLengths.data[0]), frames);
    if (!frameCount) return { buffer: new Float32Array(0), frames: 0, dim };

    /* NeMo exports [1, dim, frames]; the decoder wants [1, dim, 1], so move
     * the time axis to the front once instead of transposing every step. */
    const buffer = new Float32Array(frameCount * dim);
    for (let d = 0; d < dim; d++) {
      const row = d * frames;
      for (let t = 0; t < frameCount; t++) buffer[t * dim + d] = output.data[row + t];
    }
    return { buffer, frames: frameCount, dim };
  }

  async greedy({ buffer, frames, dim }) {
    const decoder = this.sessions.decoder;
    const zeros = () => new ort.Tensor("float32", new Float32Array(2 * 640), [2, 1, 640]);
    let state1 = zeros();
    let state2 = zeros();
    let last = BLANK;
    let t = 0;
    let steps = MAX_SYMBOLS * frames + 16;

    const tokens = [];
    const durations = [];
    const targetLength = new ort.Tensor("int32", Int32Array.from([1]), [1]);

    while (t < frames && steps > 0) {
      const output = await decoder.run({
        encoder_outputs: new ort.Tensor("float32", buffer.subarray(t * dim, (t + 1) * dim), [1, dim, 1]),
        targets: new ort.Tensor("int32", Int32Array.from([last]), [1, 1]),
        target_length: targetLength,
        input_states_1: state1,
        input_states_2: state2,
      });

      const logits = output.outputs.data;
      let token = 0;
      let best = -Infinity;
      for (let i = 0; i < VOCAB; i++) {
        if (logits[i] > best) {
          best = logits[i];
          token = i;
        }
      }
      let durationIndex = 0;
      let bestDuration = -Infinity;
      for (let i = 0; i < DURATIONS.length; i++) {
        if (logits[VOCAB + i] > bestDuration) {
          bestDuration = logits[VOCAB + i];
          durationIndex = i;
        }
      }

      let duration = DURATIONS[durationIndex];
      if (token === BLANK && duration === 0) duration = 1;

      tokens.push(token);
      durations.push(duration);
      t += duration;

      if (token !== BLANK) {
        last = token;
        state1 = output.output_states_1;
        state2 = output.output_states_2;
      }
      steps--;
    }
    return { tokens, durations };
  }

  decodeText(ids) {
    let text = "";
    for (const id of ids) {
      const piece = this.vocab[id];
      if (piece !== undefined && !SKIP.has(piece)) text += piece;
    }
    return text.replace(/▁/g, " ").trim();
  }

  clean(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  async transcribe(pcm, { onProgress } = {}) {
    const started = performance.now();
    const prepared = prepareAudio(pcm);
    if (!prepared) throw new EmptyAudioError();

    const ranges = chunkRanges(prepared);
    const parts = [];
    const words = [];
    let encodeMs = 0;
    let decodeMs = 0;

    for (let index = 0; index < ranges.length; index++) {
      const [start, end] = ranges[index];
      const piece = prepared.subarray(start, end);
      if (piece.length < 400) continue;

      const t0 = performance.now();
      const encoded = await this.encode(piece);
      const t1 = performance.now();
      if (!encoded.frames) continue;
      const { tokens } = await this.greedy(encoded);
      const t2 = performance.now();

      encodeMs += t1 - t0;
      decodeMs += t2 - t1;

      const text = this.clean(this.decodeText(tokens));
      if (text) parts.push(text);
      if (onProgress) {
        onProgress({
          done: index + 1,
          of: ranges.length,
          text: parts.join(" "),
          encodeMs,
          decodeMs,
        });
      }
    }

    const text = this.clean(parts.join(" "));
    return {
      text,
      audioSec: prepared.length / SR,
      encodeMs,
      decodeMs,
      totalMs: performance.now() - started,
      chunks: ranges.length,
    };
  }
}

async function readVocab(path) {
  const text = await readFile(path, "utf8");
  const vocab = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const cut = line.lastIndexOf(" ");
    if (cut < 0) continue;
    vocab[Number(line.slice(cut + 1))] = line.slice(0, cut);
  }
  return vocab;
}

/* A tiny helper for the CLI: text from a word list, for progress messages. */
export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
