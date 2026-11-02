import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "../src/tui.js";
import { stripAnsi, visibleWidth } from "../src/util.js";

const now = Date.now();
const history = [
  { text: "Remind me to book the flight to Lisbon on Thursday, and renew the passport before the end of the month.", at: now - 120_000, audioSec: 7.4, ms: 1280 },
  { text: "The deploy is green, and the retry logic is back in the queue worker.", at: now - 2_400_000, audioSec: 5.1, ms: 970 },
  { text: "Send Sofia the notes from the design review.", at: now - 10_800_000, audioSec: 6.2, ms: 1100 },
];

function view(overrides = {}) {
  return {
    phase: "idle",
    version: "1.0.0",
    kitty: true,
    demo: false,
    paths: { root: "~/.myna", models: "~/.myna/models" },
    model: {
      state: "ready",
      files: [],
      loaded: 0,
      total: 0,
      speed: 0,
      device: "CPU",
      loadMs: 1200,
      message: "",
      error: null,
    },
    mic: {
      state: "ready",
      name: "Built-in Microphone",
      permission: "authorized",
      warm: true,
      mode: "swift",
      message: null,
      detail: null,
    },
    history: [],
    selected: 0,
    copy: { state: "ok", method: "clipboard", index: 0 },
    toast: null,
    error: null,
    recording: null,
    transcribing: null,
    help: false,
    ...overrides,
  };
}

const screens = {
  "idle empty": view(),
  "idle legacy": view({ kitty: false }),
  "idle history": view({ history }),
  "idle older": view({ history, selected: 2 }),
  recording: view({
    phase: "recording",
    recording: {
      source: "shift",
      startedAt: now - 3200,
      levels: [-50, -30, -10, -4, -8, -20, -40, -12, -2],
      peakDb: -1,
    },
  }),
  arming: view({
    phase: "arming",
    recording: { source: "space", startedAt: now - 400, levels: [], peakDb: -60 },
    mic: { state: "preparing", name: "microphone", permission: "notDetermined", warm: false, message: "waiting for microphone permission" },
  }),
  transcribing: view({
    phase: "transcribing",
    transcribing: { startedAt: now - 400, done: 1, of: 2, encodeMs: 420, decodeMs: 180, levels: [-20, -5], peakDb: -1, partialText: "a partial" },
  }),
  help: view({ help: true }),
  error: view({
    phase: "error",
    error: {
      title: "RECOGNIZER FAILED",
      message: "The recognizer could not be loaded.",
      hint: "Press r to try again.",
      retry: "recognizer",
    },
  }),
  boot: view({
    phase: "boot",
    model: {
      state: "downloading",
      files: [
        { name: "vocab.txt", size: 93_939, loaded: 93_939 },
        { name: "preprocessor.onnx", size: 1_224_294, loaded: 1_224_294 },
        { name: "decoder_joint-model.int8.onnx", size: 18_221_404, loaded: 18_221_404 },
        { name: "encoder-model.onnx", size: 343_841_943, loaded: 100_000_000 },
      ],
      loaded: 100_000_000,
      total: 363_000_000,
      speed: 10_000_000,
      activeFile: "encoder-model.onnx",
      device: null,
      message: "",
      error: null,
    },
    mic: { state: "preparing", name: "microphone", permission: "unknown", warm: false },
  }),
};

for (const [name, value] of Object.entries(screens)) {
  test(`layout: ${name}`, () => {
    for (const [width, height] of [
      [100, 28],
      [60, 20],
    ]) {
      const text = renderToString(value, width, height);
      const lines = text.split("\n");
      assert.equal(lines.length, height, `${name} at ${width}×${height}`);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${name} line too wide: ${JSON.stringify(line)}`);
      }
    }
  });
}

test("screens contain their defining text", () => {
  assert.match(renderToString(screens["idle empty"], 100, 28), /Hold SHIFT and speak/);
  assert.match(renderToString(screens["idle empty"], 100, 28), /press SPACE to start and stop/);
  assert.match(renderToString(screens["idle legacy"], 100, 28), /Press SPACE and speak/);
  assert.match(renderToString(screens["idle history"], 100, 28), /TRANSCRIPT/);
  assert.match(renderToString(screens["idle history"], 100, 28), /copied ✓/);
  assert.match(renderToString(screens.recording, 100, 28), /RECORDING/);
  assert.match(renderToString(screens.recording, 100, 28), /release SHIFT to transcribe/);
  assert.match(renderToString(screens.arming, 100, 28), /WARMING MIC/);
  assert.match(renderToString(screens.arming, 100, 28), /waiting for microphone permission/);
  assert.match(renderToString(screens.transcribing, 100, 28), /TRANSCRIBING/);
  assert.match(renderToString(screens.help, 100, 28), /KEYS/);
  assert.match(renderToString(screens.error, 100, 28), /RECOGNIZER FAILED/);
  assert.match(renderToString(screens.boot, 100, 28), /SETTING UP/);
  assert.match(renderToString(screens.boot, 100, 28), /encoder-model\.onnx/);
  assert.match(renderToString(screens.boot, 100, 28), /29%/);
});

test("color output wraps and strips back to the plain render", () => {
  const value = screens["idle history"];
  const plain = renderToString(value, 100, 28);
  const colored = renderToString(value, 100, 28, { color: true });
  assert.notEqual(colored, plain);
  assert.equal(stripAnsi(colored), plain);
  for (const line of colored.split("\n")) {
    assert.ok(visibleWidth(line) <= 100);
  }
});

test("a tiny terminal gets a readable message", () => {
  const text = renderToString(screens["idle empty"], 40, 10);
  assert.match(text, /terminal too small/);
  assert.match(text, /48 × 15/);
  assert.equal(text.split("\n").length, 10);
});
