import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "../src/args.js";
import { Recorder } from "../src/recorder.js";

test("defaults", () => {
  const options = parseArgs([]);
  assert.equal(options.home, null);
  assert.equal(options.file, null);
  assert.equal(options.copy, true);
  assert.equal(options.history, true);
  assert.equal(options.kitty, true);
  assert.equal(options.ep, "auto");
  assert.equal(options.threads, 0);
  assert.equal(options.demo, false);
});

test("flags and values", () => {
  const options = parseArgs([
    "--home",
    "/tmp/myna",
    "--no-copy",
    "--no-history",
    "--no-kitty",
    "--cold",
    "--threads",
    "4",
    "--ep",
    "coreml",
    "--debug",
  ]);
  assert.equal(options.home, "/tmp/myna");
  assert.equal(options.copy, false);
  assert.equal(options.history, false);
  assert.equal(options.kitty, false);
  assert.equal(options.cold, true);
  assert.equal(options.threads, 4);
  assert.equal(options.ep, "coreml");
  assert.equal(options.debug, true);
});

test("positional and inline values", () => {
  const options = parseArgs(["audio.wav", "--home=/tmp/x", "--json", "--no-copy"]);
  assert.equal(options.file, "audio.wav");
  assert.equal(options.home, "/tmp/x");
  assert.equal(options.json, true);
});

test("usage errors", () => {
  assert.throws(() => parseArgs(["--json"]), UsageError);
  assert.throws(() => parseArgs(["--cold", "--warm"]), UsageError);
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["--threads", "0"]), UsageError);
  assert.throws(() => parseArgs(["--ep", "magic"]), UsageError);
  assert.throws(() => parseArgs(["--demo", "file.wav"]), UsageError);
  assert.throws(() => parseArgs(["a.wav", "b.wav"]), UsageError);
});

test("the recorder has both a warm method and an isWarm getter", () => {
  const recorder = new Recorder({ binDir: "/tmp" });
  assert.equal(typeof recorder.warm, "function");
  assert.equal(recorder.isWarm, false);
});
