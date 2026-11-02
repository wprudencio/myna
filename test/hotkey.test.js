import test from "node:test";
import assert from "node:assert/strict";
import { parseHotkey } from "../src/hotkey.js";

test("default shortcut maps to the Carbon space key", () => {
  const hotkey = parseHotkey("ctrl+alt+space");
  assert.equal(hotkey.keyCode, 49);
  assert.equal(hotkey.modifiers, 4096 | 2048);
  assert.equal(hotkey.normalized, "ctrl+alt+space");
  assert.equal(hotkey.label, "⌃⌥Space");
});

test("modifiers and keys are formatted for the menu", () => {
  const optionShift = parseHotkey("option+shift+d");
  assert.equal(optionShift.keyCode, 2);
  assert.equal(optionShift.modifiers, 2048 | 512);
  assert.equal(optionShift.label, "⌥⇧D");

  const command = parseHotkey("cmd+ctrl+space");
  assert.equal(command.modifiers, 256 | 4096);
  assert.equal(command.label, "⌃⌘Space");

  const enter = parseHotkey("ctrl+alt+enter");
  assert.equal(enter.label, "⌃⌥Return");
});

test("unsafe or unknown shortcuts are rejected", () => {
  assert.throws(() => parseHotkey("space"), /modifiers/);
  assert.throws(() => parseHotkey("shift+space"), /Shift alone|unsafe/);
  assert.throws(() => parseHotkey("ctrl+alt+nosuchkey"), /unsupported/);
  assert.throws(() => parseHotkey("hyper+space"), /unknown modifier/);
  assert.throws(() => parseHotkey(""), /empty/);
});
