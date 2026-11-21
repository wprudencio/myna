/*
 * Type text at the cursor on Linux, without touching the clipboard.
 *
 * Wayland: wtype (wlroots compositors) or ydotool (uinput, any compositor,
 * needs ydotoold running). X11: xdotool. The text is typed line by line and a
 * Return is pressed between lines, so multi-line transcripts survive. If no
 * tool is available — or typing fails part way — the caller falls back to the
 * clipboard rather than risk typing the text twice.
 */

import { spawn, spawnSync } from "node:child_process";
import { isMac, isWindows } from "./util.js";

/* Ordered tools for the session described by `env`. Pure; unit tested. */
export function typerCandidates(env = process.env) {
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const x11 = Boolean(env.DISPLAY);
  const candidates = [];
  if (wayland) candidates.push("wtype");
  if (x11) candidates.push("xdotool");
  if (wayland || x11 || env.YDOTOOL_SOCKET) candidates.push("ydotool");
  return candidates;
}

/* argv to type one line of text. Pure; unit tested. */
export function typerArgs(command, line) {
  switch (command) {
    case "xdotool":
      return ["type", "--clearmodifiers", line];
    case "wtype":
      return [line];
    default:
      /* ydotool */
      return ["type", line];
  }
}

/* argv to press Enter once. Pure; unit tested. */
export function enterArgs(command) {
  switch (command) {
    case "xdotool":
      return ["key", "Return"];
    case "wtype":
      return ["-k", "Return"];
    default:
      /* ydotool speaks evdev codes: KEY_ENTER is 28, press then release. */
      return ["key", "28:1", "28:0"];
  }
}

function whichTool(command) {
  const result = spawnSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0;
}

function runOnce(command, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch (error) {
      resolve({ code: null, error });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

/*
 * Type `text` at the cursor. Returns one of:
 *   { ok: true, command }
 *   { ok: false, reason }                      nothing was typed
 *   { ok: false, reason, partial: true, command }  some text may be at the cursor
 *
 * The runner and the tool lookup are injectable so the tests can drive the
 * line-splitting logic without any real typing tool installed.
 */
export async function typeText(text, { env = process.env, which = whichTool, run = runOnce, log = () => {} } = {}) {
  if (isMac || isWindows) return { ok: false, reason: "unsupported platform" };
  const source = String(text ?? "");
  if (!source.trim()) return { ok: false, reason: "empty text" };

  const lines = source.split("\n");
  const candidates = typerCandidates(env);
  if (!candidates.length) return { ok: false, reason: "no graphical session" };

  let firstFailure = null;
  for (const command of candidates) {
    if (!which(command)) continue;
    log(`typing with ${command}`);
    let failed = null;
    let typed = false;

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        const press = await run(command, enterArgs(command));
        if (press.code !== 0) {
          failed = press.error ? "spawn" : "enter";
          break;
        }
      }
      if (!lines[i]) continue; /* blank line: the Enter above carries it */
      const result = await run(command, typerArgs(command, lines[i]));
      if (result.code !== 0) {
        failed = result.error ? "spawn" : "type";
        break;
      }
      typed = true;
    }

    if (!failed) return { ok: true, command };
    /* Once anything was typed, switching tools could duplicate the text. */
    if (typed) return { ok: false, reason: failed, partial: true, command };
    firstFailure ??= { command, reason: failed };
  }

  return {
    ok: false,
    reason: firstFailure ? `${firstFailure.reason} via ${firstFailure.command}` : "no typing tool found",
  };
}
