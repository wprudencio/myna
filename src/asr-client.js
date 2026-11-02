/* Main-thread handle for the ASR service process. */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICE = fileURLToPath(new URL("./asr-service.js", import.meta.url));

function makeError(message) {
  const error = new Error(message.message ?? String(message));
  if (message.name) error.name = message.name;
  if (message.code) error.code = message.code;
  if (message.stack) error.stack = message.stack;
  return error;
}

export class RecognizerClient {
  constructor({ log } = {}) {
    this.log = log ?? (() => {});
    this.closed = false;
    this.ready = false;
    this.device = null;
    this.loadMs = 0;
    this.warmupMs = 0;
    this.pendingLoad = null;
    this.pending = new Map();
    this.nextId = 1;
    this.statusHandler = null;
    this.stderr = "";

    this.child = fork(SERVICE, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
      env: process.env,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data) => {
      this.stderr = `${this.stderr}${data}`.slice(-8000);
      for (const line of data.split(/\r?\n/)) {
        if (line.trim()) this.log(`asr: ${line.trim()}`);
      }
    });
    this.child.on("message", (message) => this._onMessage(message));
    this.child.on("error", (error) => this._failAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      const tail = this.stderr.trim().split("\n").slice(-4).join("\n");
      this._failAll(new Error(`the recognizer service exited (${code ?? signal})${tail ? `\n${tail}` : ""}`));
    });
  }

  _onMessage(message) {
    if (message.type === "status") {
      this.statusHandler?.(message.status);
      return;
    }
    if (message.type === "ready") {
      this.ready = true;
      this.device = message.device;
      this.loadMs = message.loadMs;
      this.warmupMs = message.warmupMs;
      const pending = this.pendingLoad;
      this.pendingLoad = null;
      pending?.resolve(this);
      return;
    }
    if (message.type === "error" && message.scope === "load") {
      const pending = this.pendingLoad;
      this.pendingLoad = null;
      pending?.reject(makeError(message));
      return;
    }
    if (message.type === "progress") {
      const pending = this.pending.get(message.id);
      pending?.onProgress?.({
        done: message.done,
        of: message.of,
        text: message.text,
        encodeMs: message.encodeMs,
        decodeMs: message.decodeMs,
      });
      return;
    }
    if (message.type === "result") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (message.type === "error") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.reject(makeError(message));
    }
  }

  _failAll(error) {
    if (this.closed) return;
    const load = this.pendingLoad;
    this.pendingLoad = null;
    load?.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  load({ modelDir, ep, threads, onStatus }) {
    if (this.pendingLoad) return this.pendingLoad.promise;
    this.statusHandler = onStatus;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pendingLoad = { promise, resolve, reject };
    this._send({ type: "load", modelDir, ep, threads }, reject);
    return promise;
  }

  transcribe(pcm, { onProgress } = {}) {
    if (this.closed) return Promise.reject(new Error("the recognizer is closed"));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    this._send({ type: "transcribe", id, pcm }, (error) => {
      this.pending.delete(id);
      reject(error);
    });
    return promise;
  }

  _send(message, onError) {
    if (this.closed || !this.child.connected) {
      onError?.(new Error("the recognizer service is not running"));
      return;
    }
    this.child.send(message, (error) => {
      if (error) onError?.(error);
    });
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("the recognizer was stopped");
    error.code = "STOPPED";
    const load = this.pendingLoad;
    this.pendingLoad = null;
    load?.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}
