/*
 * Model files for Parakeet Redux, fetched from the Hugging Face Hub and kept
 * in a local cache. The encoder is 344 MB, so downloads are split into 8 MB
 * ranges over several connections and can be resumed where they stopped.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatBytes, sleep } from "./util.js";

export const REPO = "mrfakename/parakeet-redux-ONNX";
const HUB = "https://huggingface.co";
const BASE = `${HUB}/${REPO}/resolve/main/`;
const API = `${HUB}/api/models/${REPO}/tree/main?recursive=true`;
const CHUNK = 8 * 1024 * 1024;
const UA = "myna/1.0";

/* Sizes at the time of writing, used when the Hub API is unreachable or rate
 * limited. They are only a starting point: the API wins when it answers. */
export const MODEL_FILES = [
  { name: "vocab.txt", size: 93_939, label: "vocabulary" },
  { name: "preprocessor.onnx", size: 1_224_294, label: "preprocessor" },
  { name: "decoder_joint-model.int8.onnx", size: 18_221_404, label: "decoder" },
  { name: "encoder-model.onnx", size: 343_841_943, label: "encoder" },
];

export function resolveHome(explicit) {
  const root = resolve(
    explicit || process.env.MYNA_HOME || process.env.PARAKEET_HOME || join(homedir(), ".myna")
  );
  return {
    root,
    models: join(root, "models"),
    bin: join(root, "bin"),
    history: join(root, "history.json"),
    log: join(root, "debug.log"),
  };
}

const anySignal = (signals) => {
  const list = signals.filter(Boolean);
  if (!list.length) return new AbortController().signal;
  return AbortSignal.any(list);
};

async function statSafe(path) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function fetchManifestSizes(signal) {
  try {
    const timeout = AbortSignal.timeout(8_000);
    const response = await fetch(API, {
      signal: anySignal([signal, timeout]),
      headers: { "user-agent": UA },
    });
    if (!response.ok) return {};
    const entries = await response.json();
    const sizes = {};
    for (const entry of entries) {
      if (entry && typeof entry.path === "string") {
        sizes[entry.path] = entry.lfs?.size ?? entry.size;
      }
    }
    return sizes;
  } catch {
    return {};
  }
}

function chunkLength(size, index) {
  return Math.min(CHUNK, size - index * CHUNK);
}

function chunkCount(size) {
  return Math.ceil(size / CHUNK);
}

async function readState(path, size) {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    if (parsed && parsed.size === size && Array.isArray(parsed.done)) {
      return new Set(parsed.done.filter((n) => Number.isInteger(n) && n >= 0 && n < chunkCount(size)));
    }
  } catch {}
  return new Set();
}

async function writeState(path, size, done) {
  const body = JSON.stringify({ size, done: [...done].sort((a, b) => a - b) });
  const temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, body);
  await fs.rename(temp, path);
}

async function openPart(path, size) {
  let handle;
  try {
    handle = await fs.open(path, "r+");
    const info = await handle.stat();
    if (info.size !== size) {
      await handle.truncate(size);
      return { handle, fresh: true };
    }
  } catch {
    handle = await fs.open(path, "w");
    await handle.truncate(size);
    return { handle, fresh: true };
  }
  return { handle, fresh: false };
}

class RangeUnsupported extends Error {}

async function downloadWhole(url, file, options) {
  const { partPath, handle, done, signal, onBytes, save } = options;
  await handle.truncate(0);
  done.clear();
  await save();
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetch(url, {
    signal: anySignal([signal, timeout]),
    headers: { "user-agent": UA },
  });
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  let position = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    if (!value) continue;
    await handle.write(value, 0, value.length, position);
    position += value.length;
    onBytes(value.length, false);
  }
  if (position !== file.size) throw new Error(`${file.name}: expected ${file.size} bytes, got ${position}`);
  await handle.truncate(file.size);
}

async function downloadFile(file, { dir, signal, onBytes, onStatus }) {
  const finalPath = join(dir, file.name);
  const partPath = `${finalPath}.part`;
  const statePath = `${partPath}.json`;

  const existing = await statSafe(finalPath);
  if (existing?.size === file.size) {
    onBytes(file.size, true);
    onStatus?.({ phase: "file-done", file, cached: true });
    return;
  }
  if (existing) await fs.rm(finalPath, { force: true });

  const part = await statSafe(partPath);
  let done = part ? await readState(statePath, file.size) : new Set();
  const { handle, fresh } = await openPart(partPath, file.size);
  if (fresh) {
    done = new Set();
    await writeState(statePath, file.size, done);
  }

  /* Count the bytes that are already on disk. They are part of the progress
   * but not of the current download speed. */
  for (const index of done) onBytes(chunkLength(file.size, index), true);

  let saveChain = Promise.resolve();
  const save = () => {
    saveChain = saveChain.then(() => writeState(statePath, file.size, done));
    return saveChain;
  };

  const totalChunks = chunkCount(file.size);
  const missing = totalChunks - done.size;
  onStatus?.({ phase: "file-start", file, resumed: done.size > 0, missing });

  const url = BASE + file.name;
  const controller = new AbortController();
  const linked = anySignal([signal, controller.signal]);
  const concurrency = file.size > 64 * 1024 * 1024 ? 8 : Math.min(4, Math.max(1, missing));

  const worker = async (state) => {
    for (;;) {
      if (state.failure) return;
      const index = state.next++;
      if (index >= totalChunks) return;
      if (done.has(index)) continue;

      const start = index * CHUNK;
      const end = start + chunkLength(file.size, index) - 1;
      let attempt = 0;
      for (;;) {
        try {
          const timeout = AbortSignal.timeout(90_000);
          const response = await fetch(url, {
            signal: anySignal([linked, timeout]),
            headers: { "user-agent": UA, range: `bytes=${start}-${end}` },
          });
          if (response.status === 200 && totalChunks > 1) {
            await response.body?.cancel().catch(() => {});
            throw new RangeUnsupported();
          }
          if (response.status !== 206 && response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          const expected = end - start + 1;
          if (buffer.length !== expected) {
            throw new Error(`short range: ${buffer.length} of ${expected} bytes`);
          }
          let written = 0;
          while (written < buffer.length) {
            const result = await handle.write(buffer, written, buffer.length - written, start + written);
            if (!result.bytesWritten) throw new Error("could not write to disk");
            written += result.bytesWritten;
          }
          done.add(index);
          await save();
          onBytes(buffer.length, false);
          attempt = 0;
          break;
        } catch (error) {
          if (error instanceof RangeUnsupported) throw error;
          if (signal.aborted) throw error;
          attempt++;
          if (attempt >= 4) throw new Error(`${file.name}: ${error.message}`);
          await sleep(400 * attempt, signal).catch(() => {});
        }
      }
    }
  };

  const state = { next: 0, failure: null };
  const workers = Array.from({ length: concurrency }, () => worker(state));
  let failure = null;
  try {
    const results = await Promise.allSettled(workers);
    failure = results.find((result) => result.status === "rejected")?.reason ?? null;
  } finally {
    controller.abort();
    await saveChain.catch(() => {});
  }

  if (failure instanceof RangeUnsupported) {
    try {
      await downloadWhole(url, file, {
        partPath,
        handle,
        done,
        signal,
        onBytes,
        save,
      });
      failure = null;
    } catch (error) {
      failure = error;
    }
  }

  if (failure) {
    await handle.close().catch(() => {});
    throw failure;
  }

  await handle.sync().catch(() => {});
  await handle.close();
  const info = await statSafe(partPath);
  if (info?.size !== file.size) throw new Error(`${file.name}: incomplete file (${info?.size ?? 0} bytes)`);
  await fs.rm(finalPath, { force: true });
  await fs.rename(partPath, finalPath);
  await fs.rm(statePath, { force: true });
  onStatus?.({ phase: "file-done", file, cached: false });
}

export async function ensureModel({ paths, signal = new AbortController().signal, onProgress, onStatus }) {
  await fs.mkdir(paths.models, { recursive: true });
  onStatus?.({ phase: "manifest" });

  const sizes = await fetchManifestSizes(signal);
  const files = MODEL_FILES.map((file) => ({
    ...file,
    size: Number(sizes[file.name]) || file.size,
  }));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const loadedByFile = new Map(files.map((file) => [file.name, 0]));
  let loaded = 0;
  let sessionBytes = 0;

  const emit = (activeFile = null) => {
    onProgress?.({
      loaded,
      total,
      sessionBytes,
      activeFile,
      files: files.map((file) => ({
        name: file.name,
        label: file.label,
        size: file.size,
        loaded: loadedByFile.get(file.name) ?? 0,
      })),
    });
  };

  /* Everything that is already complete counts before we start. */
  for (const file of files) {
    const info = await statSafe(join(paths.models, file.name));
    if (info?.size === file.size) {
      loadedByFile.set(file.name, file.size);
      loaded += file.size;
    }
  }
  emit();
  if (loaded === total) {
    onStatus?.({ phase: "done", cached: true });
    return { files, total };
  }

  for (const file of files) {
    const current = loadedByFile.get(file.name) ?? 0;
    if (current === file.size) continue;
    emit(file.name);
    await downloadFile(file, {
      dir: paths.models,
      signal,
      onBytes: (bytes, resumed) => {
        loaded += bytes;
        if (!resumed) sessionBytes += bytes;
        loadedByFile.set(file.name, (loadedByFile.get(file.name) ?? 0) + bytes);
        emit(file.name);
      },
      onStatus,
    });
  }

  onStatus?.({ phase: "done", cached: false, total });
  return { files, total };
}

export function modelSummary(files) {
  return files.map((file) => `${file.name} (${formatBytes(file.size)})`).join(", ");
}
