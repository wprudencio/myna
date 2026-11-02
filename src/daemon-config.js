/* Shared files and defaults for `myna daemon`. */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_HOTKEY, parseHotkey } from "./hotkey.js";

export const DEFAULT_CONFIG = {
  hotkey: DEFAULT_HOTKEY,
  sounds: true,
  warmSeconds: 120,
  recorder: null,
};

export function daemonPaths(paths) {
  return {
    state: join(paths.root, "daemon.json"),
    config: join(paths.root, "config.json"),
    menubar: join(paths.root, "menubar.json"),
    log: join(paths.root, "daemon.log"),
    bundle: join(paths.root, "Myna.app"),
  };
}

export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object") {
    if (typeof raw.hotkey === "string") {
      const hotkey = parseHotkey(raw.hotkey);
      config.hotkey = hotkey.normalized;
    }
    if (typeof raw.sounds === "boolean") config.sounds = raw.sounds;
    if (Number.isInteger(raw.warmSeconds) && raw.warmSeconds >= -1) config.warmSeconds = raw.warmSeconds;
    if (raw.recorder === null || typeof raw.recorder === "string") config.recorder = raw.recorder || null;
  }
  return config;
}

export async function readConfig(paths) {
  try {
    const raw = JSON.parse(await fs.readFile(daemonPaths(paths).config, "utf8"));
    return normalizeConfig(raw);
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw error;
  }
}

export async function writeConfig(paths, config) {
  const normalized = normalizeConfig(config);
  await writeJsonAtomic(daemonPaths(paths).config, normalized);
  return normalized;
}

export async function writeMenubarConfig(paths, { node, daemon, home, hotkey, sounds }) {
  const parsed = parseHotkey(hotkey);
  const body = {
    node,
    daemon,
    home,
    keyCode: parsed.keyCode,
    modifiers: parsed.modifiers,
    hotkey: parsed.normalized,
    hotkeyLabel: parsed.label,
    sounds: Boolean(sounds),
  };
  await writeJsonAtomic(daemonPaths(paths).menubar, body);
  return body;
}

export async function readMenubarConfig(paths) {
  return JSON.parse(await fs.readFile(daemonPaths(paths).menubar, "utf8"));
}

export async function readState(paths) {
  try {
    const state = JSON.parse(await fs.readFile(daemonPaths(paths).state, "utf8"));
    if (!state || typeof state !== "object") return null;
    return state;
  } catch {
    return null;
  }
}

export async function removeState(paths) {
  await fs.rm(daemonPaths(paths).state, { force: true }).catch(() => {});
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, path);
}

export async function waitForState(paths, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(paths);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export async function recentLog(paths, lines = 8) {
  try {
    const text = await fs.readFile(daemonPaths(paths).log, "utf8");
    return text.trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}
