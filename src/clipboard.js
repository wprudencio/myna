/*
 * Clipboard output. Native tools first (pbcopy on macOS, wl-copy/xclip/xsel
 * on Linux, clip on Windows), with an OSC 52 escape sequence as the fallback
 * for remote sessions and terminals that keep the clipboard themselves.
 */

import { spawn, spawnSync } from "node:child_process";
import { isMac, isWindows } from "./util.js";

const binCache = new Map();

function which(command) {
  if (binCache.has(command)) return binCache.get(command);
  const finder = isWindows ? "where" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const found = result.status === 0 ? result.stdout.split("\n")[0].trim() : null;
  binCache.set(command, found);
  return found;
}

function run(command, args, input, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function copyToClipboard(text) {
  const candidates = [];
  if (isMac) candidates.push({ command: "pbcopy", args: [], method: "clipboard" });
  else if (isWindows) candidates.push({ command: "clip", args: [], method: "clipboard" });
  else {
    if (process.env.WAYLAND_DISPLAY) candidates.push({ command: "wl-copy", args: [], method: "clipboard" });
    candidates.push({ command: "xclip", args: ["-selection", "clipboard"], method: "clipboard" });
    candidates.push({ command: "xsel", args: ["--clipboard", "--input"], method: "clipboard" });
  }

  for (const candidate of candidates) {
    if (!which(candidate.command)) continue;
    const result = await run(candidate.command, candidate.args, text);
    if (result.ok) return { ok: true, method: candidate.method, command: candidate.command };
  }
  return { ok: false, method: null };
}

/* OSC 52: base64 so the payload survives any encoding in between. tmux needs
 * its passthrough wrapper and doubled escapes. */
export function osc52(text, { tmux = Boolean(process.env.TMUX) } = {}) {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const sequence = `\x1b]52;c;${payload}\x07`;
  if (!tmux) return sequence;
  return `\x1bPtmux;\x1b${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export function clipboardTool() {
  if (isMac) return which("pbcopy") ? "pbcopy" : null;
  if (isWindows) return which("clip") ? "clip" : null;
  if (process.env.WAYLAND_DISPLAY && which("wl-copy")) return "wl-copy";
  if (which("xclip")) return "xclip";
  if (which("xsel")) return "xsel";
  return null;
}
