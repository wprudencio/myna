/* Parse the shortcut string into the Carbon key code and modifier mask the
 * menu bar helper needs. */

const KEYCODES = {
  space: 49,
  return: 36,
  enter: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  1: 18,
  2: 19,
  3: 20,
  4: 21,
  6: 22,
  5: 23,
  "=": 24,
  9: 25,
  7: 26,
  "-": 27,
  8: 28,
  0: 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

const MODIFIERS = {
  ctrl: 4096,
  control: 4096,
  alt: 2048,
  option: 2048,
  opt: 2048,
  shift: 512,
  cmd: 256,
  command: 256,
  super: 256,
};

const SYMBOLS = {
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  opt: "⌥",
  shift: "⇧",
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
};

function keyLabel(key) {
  if (key === "space") return "Space";
  if (key === "return" || key === "enter") return "Return";
  if (key === "tab") return "Tab";
  if (key === "escape" || key === "esc") return "Esc";
  if (key === "left") return "←";
  if (key === "right") return "→";
  if (key === "up") return "↑";
  if (key === "down") return "↓";
  if (key.length === 1) return key.toUpperCase();
  return key.toUpperCase();
}

export function parseHotkey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("shortcut is empty");
  }
  const parts = value
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) throw new Error("shortcut needs modifiers and a key");

  const key = parts.pop();
  if (!(key in KEYCODES)) throw new Error(`unsupported shortcut key “${key}”`);

  let modifiers = 0;
  const names = [];
  for (const part of parts) {
    if (!(part in MODIFIERS)) throw new Error(`unknown modifier “${part}”`);
    modifiers |= MODIFIERS[part];
    if (!names.includes(part)) names.push(part);
  }
  if (!(modifiers & (MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.cmd))) {
    throw new Error("shortcut needs Ctrl, Option or Command (Shift alone is unsafe)");
  }

  const ordered = ["ctrl", "control", "alt", "option", "opt", "shift", "cmd", "command", "super"]
    .filter((name) => names.includes(name))
    .filter((name, index, list) => list.indexOf(name) === index);
  const label = ordered.map((name) => SYMBOLS[name] ?? "").join("") + keyLabel(key);
  const normalized = [...new Set(parts)].join("+") + `+${key}`;

  return {
    keyCode: KEYCODES[key],
    modifiers,
    key,
    label,
    normalized,
  };
}

export const DEFAULT_HOTKEY = "ctrl+alt+space";
