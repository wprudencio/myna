import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonPaths,
  DEFAULT_CONFIG,
  isProcessAlive,
  normalizeConfig,
  readConfig,
  readMenubarConfig,
  readState,
  removeState,
  writeConfig,
  writeJsonAtomic,
  writeMenubarConfig,
} from "../src/daemon-config.js";

test("config defaults and normalization", () => {
  const paths = { root: join(tmpdir(), "myna-config-test") };
  assert.deepEqual(daemonPaths(paths).config, join(paths.root, "config.json"));
  assert.equal(normalizeConfig().warmSeconds, DEFAULT_CONFIG.warmSeconds);

  const config = normalizeConfig({
    hotkey: "cmd+shift+space",
    sounds: false,
    warmSeconds: -1,
    recorder: "cat mic.raw",
  });
  assert.equal(config.hotkey, "cmd+shift+space");
  assert.equal(config.sounds, false);
  assert.equal(config.warmSeconds, -1);
  assert.equal(config.recorder, "cat mic.raw");

  assert.throws(() => normalizeConfig({ hotkey: "shift+space" }), /Shift alone|unsafe/);
});

test("config and menubar files round-trip", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "myna-config-"));
  const paths = { root };
  try {
    assert.deepEqual(await readConfig(paths), DEFAULT_CONFIG);
    await writeConfig(paths, {
      hotkey: "ctrl+alt+space",
      sounds: true,
      warmSeconds: 0,
      recorder: null,
    });
    const config = await readConfig(paths);
    assert.equal(config.warmSeconds, 0);

    await writeMenubarConfig(paths, {
      node: "/usr/local/bin/node",
      daemon: "/tmp/daemon.js",
      home: root,
      hotkey: "ctrl+alt+space",
      sounds: true,
    });
    const menubar = await readMenubarConfig(paths);
    assert.equal(menubar.keyCode, 49);
    assert.equal(menubar.modifiers, 6144);
    assert.equal(menubar.hotkeyLabel, "⌃⌥Space");
    assert.equal(menubar.node, "/usr/local/bin/node");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("state helpers and process liveness", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "myna-state-"));
  const paths = { root };
  try {
    assert.equal(await readState(paths), null);
    await writeJsonAtomic(daemonPaths(paths).state, {
      appPid: process.pid,
      status: "idle",
    });
    const state = await readState(paths);
    assert.equal(state.status, "idle");
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(99999999), false);
    await removeState(paths);
    assert.equal(await readState(paths), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("corrupt config is an error, missing config is not", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "myna-config-"));
  const paths = { root };
  try {
    await fs.writeFile(daemonPaths(paths).config, "{ nope");
    await assert.rejects(() => readConfig(paths), /JSON|Unexpected|property/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
