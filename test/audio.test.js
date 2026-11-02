import test from "node:test";
import assert from "node:assert/strict";
import { chunkRanges, EmptyAudioError, prepareAudio } from "../src/asr.js";

const SR = 16000;

function tone(seconds, amplitude = 0.4, frequency = 220) {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / SR) * amplitude;
  }
  return samples;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test("trims silence and lifts the level", () => {
  const silence = new Float32Array(SR / 2);
  const input = concat(silence, tone(1.0), silence);
  const out = prepareAudio(input);
  assert.ok(out);
  assert.ok(out.length > SR && out.length < SR * 2);
  let peak = 0;
  for (const sample of out) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak > 0.8, `peak ${peak}`);
});

test("rejects silent or very short clips", () => {
  assert.equal(prepareAudio(new Float32Array(SR)), null);
  assert.equal(prepareAudio(tone(0.1)), null);
  assert.throws(() => {
    throw new EmptyAudioError();
  }, EmptyAudioError);
});

test("short audio is one chunk", () => {
  const ranges = chunkRanges(new Float32Array(SR * 10));
  assert.deepEqual(ranges, [[0, SR * 10]]);
});

test("long audio is cut into contiguous chunks no longer than 30s", () => {
  const pcm = tone(65, 0.2);
  const ranges = chunkRanges(pcm);
  assert.ok(ranges.length >= 3);
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges.at(-1)[1], pcm.length);
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    assert.ok(end > start);
    assert.ok(end - start <= SR * 30);
    if (i > 0) assert.equal(ranges[i - 1][1], start);
  }
});
