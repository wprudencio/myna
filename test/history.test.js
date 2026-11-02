import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHistory, loadHistory, saveHistory } from "../src/history.js";

test("history round-trips newest first and caps at the limit", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "myna-history-"));
  const path = join(dir, "history.json");
  try {
    let entries = [];
    for (let i = 0; i < 105; i++) {
      entries = addHistory(entries, { text: `entry ${i}`, at: i, audioSec: 1, ms: 10 }, 100);
    }
    assert.equal(entries.length, 100);
    assert.equal(entries[0].text, "entry 104");
    assert.equal(entries.at(-1).text, "entry 5");

    await saveHistory(path, entries);
    const loaded = await loadHistory(path);
    assert.equal(loaded.length, 100);
    assert.equal(loaded[0].text, "entry 104");
    assert.equal(loaded[0].audioSec, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a missing or broken history file is empty, not an error", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "myna-history-"));
  const path = join(dir, "history.json");
  try {
    assert.deepEqual(await loadHistory(path), []);
    await fs.writeFile(path, "{ nope");
    assert.deepEqual(await loadHistory(path), []);
    await fs.writeFile(path, JSON.stringify({ entries: [{ text: "" }, { text: "ok", at: 1 }] }));
    const loaded = await loadHistory(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].text, "ok");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
