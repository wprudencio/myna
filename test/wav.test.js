import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAudioFile, readPcm16Wav } from "../src/wav.js";

function makeWav({ sampleRate = 16000, channels = 1, samples, bits = 16, format = 1 }) {
  const frameCount = samples.length / channels;
  const dataSize = frameCount * channels * (bits / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buffer.writeUInt16LE(channels * (bits / 8), 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frameCount * channels; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

test("reads 16 kHz mono PCM16 and averages stereo", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "myna-wav-"));
  try {
    const mono = join(dir, "mono.wav");
    const stereo = join(dir, "stereo.wav");
    await fs.writeFile(mono, makeWav({ samples: [0, 1000, -1000, 32767, -32768] }));
    await fs.writeFile(stereo, makeWav({ channels: 2, samples: [1000, -1000, 2000, 0] }));

    const one = await readPcm16Wav(mono);
    assert.equal(one.channels, 1);
    assert.deepEqual([...one.samples], [0, 1000, -1000, 32767, -32768]);

    const two = await readPcm16Wav(stereo);
    assert.equal(two.channels, 2);
    assert.deepEqual([...two.samples], [0, 1000]);

    const loaded = await loadAudioFile(mono);
    assert.equal(loaded.tempDir, null);
    assert.equal(loaded.converted, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rejects the wrong sample rate and non-WAV data", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "myna-wav-"));
  try {
    const bad = join(dir, "bad.wav");
    await fs.writeFile(bad, makeWav({ sampleRate: 8000, samples: [1, 2, 3] }));
    await assert.rejects(() => readPcm16Wav(bad), /16 kHz/);

    const text = join(dir, "text.wav");
    await fs.writeFile(text, "not a wave file");
    await assert.rejects(() => readPcm16Wav(text), /RIFF/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
