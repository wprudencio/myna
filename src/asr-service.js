/* ASR service process. Runs the ONNX sessions outside the TUI process so a
 * slow load, a long transcription, or a quit never blocks the interface, and
 * so the TUI can kill it without touching ORT's native teardown. */

import { Recognizer } from "./asr.js";

let recognizer = null;

const post = (message) => {
  if (!process.send) return;
  try {
    process.send(message);
  } catch {}
};

process.on("disconnect", () => process.exit(0));

process.on("message", async (message) => {
  try {
    if (message.type === "load") {
      recognizer = new Recognizer();
      await recognizer.load({
        modelDir: message.modelDir,
        ep: message.ep,
        threads: message.threads,
        onStatus: (status) => post({ type: "status", status }),
      });
      post({
        type: "ready",
        device: recognizer.device,
        loadMs: recognizer.loadMs,
        warmupMs: recognizer.warmupMs,
      });
      return;
    }

    if (message.type === "transcribe") {
      const result = await recognizer.transcribe(message.pcm, {
        onProgress: (progress) => post({ type: "progress", id: message.id, ...progress }),
      });
      post({ type: "result", id: message.id, ...result });
      return;
    }

    if (message.type === "shutdown") process.exit(0);
  } catch (error) {
    post({
      type: "error",
      scope: message.type,
      id: message.id,
      name: error?.name ?? "Error",
      code: error?.code ?? null,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    });
  }
});

process.on("uncaughtException", (error) => {
  post({
    type: "error",
    scope: "service",
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  });
  process.exit(1);
});
