/* Renders the main screens without a TTY. Useful while tweaking the layout:
 *   npm run render */

import { renderToString } from "../src/tui.js";

const now = Date.now();
const view = {
  phase: "idle",
  kitty: true,
  demo: false,
  paths: { models: "~/.myna/models" },
  model: {
    state: "ready",
    files: [],
    total: 347_000_000,
    loaded: 347_000_000,
    speed: 0,
    device: "CPU",
    loadMs: 1840,
  },
  mic: {
    state: "ready",
    name: "Built-in Microphone",
    permission: "authorized",
    warm: true,
    mode: "swift",
  },
  history: [],
  selected: 0,
  copy: { state: "ok", method: "clipboard", index: 0 },
  toast: null,
  error: null,
  recording: null,
  transcribing: null,
  help: false,
};

const history = [
  {
    text: "Remind me to book the flight to Lisbon on Thursday, and to renew the passport before the end of the month.",
    at: now - 4 * 60_000,
    audioSec: 7.4,
    ms: 1280,
  },
  {
    text: "The deploy is green. I moved the retry logic into the queue worker and the tests are passing again.",
    at: now - 38 * 60_000,
    audioSec: 5.1,
    ms: 970,
  },
  {
    text: "Send Sofia the notes from the design review, especially the part about the empty state screens.",
    at: now - 3 * 3600_000,
    audioSec: 6.2,
    ms: 1100,
  },
];

function show(title, state, width = 100, height = 28) {
  console.log(`\n\n=== ${title} (${width}×${height}) ===\n`);
  console.log(renderToString(state, width, height));
}

show("boot · downloading", {
  ...view,
  phase: "boot",
  model: {
    state: "downloading",
    files: [
      { name: "vocab.txt", label: "vocabulary", size: 93_939, loaded: 93_939 },
      { name: "preprocessor.onnx", label: "preprocessor", size: 1_224_294, loaded: 1_224_294 },
      { name: "decoder_joint-model.int8.onnx", label: "decoder", size: 18_221_404, loaded: 18_221_404 },
      { name: "encoder-model.onnx", label: "encoder", size: 343_841_943, loaded: 237_000_000 },
    ],
    activeFile: "encoder-model.onnx",
    loaded: 256_000_000,
    total: 363_000_000,
    speed: 12_400_000,
  },
  mic: { state: "preparing", name: "microphone", permission: "notDetermined", warm: false },
});

show("boot · loading", {
  ...view,
  phase: "boot",
  model: {
    state: "loading",
    message: "loading the encoder…",
    files: [
      { name: "vocab.txt", size: 93_939, loaded: 93_939 },
      { name: "preprocessor.onnx", size: 1_224_294, loaded: 1_224_294 },
      { name: "decoder_joint-model.int8.onnx", size: 18_221_404, loaded: 18_221_404 },
      { name: "encoder-model.onnx", size: 343_841_943, loaded: 343_841_943 },
    ],
    loaded: 363_000_000,
    total: 363_000_000,
  },
});

show("idle · empty, hold shift", view);
show("idle · empty, legacy keys", { ...view, kitty: false });
show("idle · history", { ...view, history, selected: 0, copy: { state: "ok", method: "clipboard", index: 0 } });
show("idle · older selected", { ...view, history, selected: 1, copy: { state: "ok", method: "clipboard", index: 0 } });

show("recording", {
  ...view,
  phase: "recording",
  history,
  recording: { startedAt: now - 4200, levels: [-50, -44, -38, -30, -22, -16, -10, -6, -3, -8, -14, -20, -12, -6, -2, -1, -4, -9, -15, -24, -32, -40, -45, -38, -30, -22, -14, -8, -4, -2, -1, -5, -12, -20, -30, -42, -50, -44, -36, -28, -20, -12, -6, -3, -7, -14, -22, -30], source: "shift", peakDb: -1 },
});

show("arming", {
  ...view,
  phase: "arming",
  mic: { ...view.mic, warm: false },
  recording: { startedAt: now - 600, levels: [], source: "space", peakDb: undefined },
});

show("transcribing", {
  ...view,
  phase: "transcribing",
  history,
  recording: null,
  transcribing: { startedAt: now - 700, done: 1, of: 1, encodeMs: 420, decodeMs: 180, levels: [-30, -20, -10, -4, -2, -8, -20, -30], peakDb: -1 },
});

show("help", { ...view, help: true, kitty: false });
show("error", {
  ...view,
  phase: "error",
  error: {
    title: "MICROPHONE UNAVAILABLE",
    message: "The microphone helper could not be built.",
    hint: "Install the Xcode command line tools with xcode-select --install, then press r to try again.",
    retry: true,
  },
});

show("narrow", { ...view, history, selected: 0 }, 56, 20);
show("small", { ...view }, 44, 12);
