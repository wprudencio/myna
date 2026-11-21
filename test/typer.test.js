import test from "node:test";
import assert from "node:assert/strict";
import { typerCandidates, typerArgs, enterArgs, typeText } from "../src/typer.js";

test("candidate tools follow the session", () => {
  assert.deepEqual(typerCandidates({ WAYLAND_DISPLAY: "wayland-0" }), ["wtype", "ydotool"]);
  assert.deepEqual(typerCandidates({ DISPLAY: ":0" }), ["xdotool", "ydotool"]);
  assert.deepEqual(typerCandidates({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }), [
    "wtype",
    "xdotool",
    "ydotool",
  ]);
  assert.deepEqual(typerCandidates({ YDOTOOL_SOCKET: "/run/ydotoold.socket" }), ["ydotool"]);
  assert.deepEqual(typerCandidates({}), []);
});

test("per-tool argv for typing and Enter", () => {
  assert.deepEqual(typerArgs("xdotool", "hello"), ["type", "--clearmodifiers", "hello"]);
  assert.deepEqual(typerArgs("wtype", "hello"), ["hello"]);
  assert.deepEqual(typerArgs("ydotool", "hello"), ["type", "hello"]);
  assert.deepEqual(enterArgs("xdotool"), ["key", "Return"]);
  assert.deepEqual(enterArgs("wtype"), ["-k", "Return"]);
  assert.deepEqual(enterArgs("ydotool"), ["key", "28:1", "28:0"]);
});

test("typeText walks candidates until one works", async () => {
  const calls = [];
  const result = await typeText("one\ntwo", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    which: (command) => command !== "wtype",
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { code: command === "xdotool" ? 1 : 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, "ydotool");
  assert.deepEqual(calls, [
    ["xdotool", "type", "--clearmodifiers", "one"],
    ["ydotool", "type", "one"],
    ["ydotool", "key", "28:1", "28:0"],
    ["ydotool", "type", "two"],
  ]);
});

test("typeText stops instead of switching tools mid-text", async () => {
  const calls = [];
  const result = await typeText("one\ntwo", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    which: () => true,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "xdotool" && args[2] === "two") return { code: 1 };
      return { code: 0 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.command, "xdotool");
  assert.equal(result.reason, "type");
  /* No ydotool attempts after the partial failure. */
  assert.equal(calls.filter(([command]) => command === "ydotool").length, 0);
});

test("typeText fails safely without a session, tools, or text", async () => {
  assert.deepEqual(await typeText("hi", { platform: "linux", env: {} }), {
    ok: false,
    reason: "no graphical session",
  });
  assert.deepEqual(
    await typeText("hello", { platform: "linux", env: { DISPLAY: ":0" }, which: () => false }),
    { ok: false, reason: "no typing tool found" }
  );
  assert.deepEqual(await typeText(""), { ok: false, reason: "empty text" });
  assert.deepEqual(await typeText("hello", { platform: "darwin" }), {
    ok: false,
    reason: "unsupported platform",
  });
});
