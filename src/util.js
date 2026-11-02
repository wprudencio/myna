/* Small helpers shared by the TUI, the downloader and the CLI. */

export const isMac = process.platform === "darwin";
export const isWindows = process.platform === "win32";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function formatClock(ms) {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
}

export function formatTime(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatAgo(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return formatTime(timestamp);
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  if (bytesPerSecond < 1e6) return `${(bytesPerSecond / 1e3).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
}

export function formatRealtime(audioSec, wallMs) {
  if (!audioSec || !wallMs) return "";
  const factor = audioSec / (wallMs / 1000);
  if (!Number.isFinite(factor)) return "";
  return `${factor >= 10 ? factor.toFixed(0) : factor.toFixed(1)}× realtime`;
}

/* ------------------------------------------------------------------ text -- */

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, "");
}

/* Width of one code point. Terminals disagree at the margins; this covers the
 * common cases without pulling in a unicode table. */
export function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp < 0x20) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const char of plain) width += charWidth(char.codePointAt(0));
  return width;
}

export function sliceWidth(text, maxWidth) {
  if (maxWidth <= 0) return "";
  let width = 0;
  let out = "";
  for (const char of text) {
    const w = charWidth(char.codePointAt(0));
    if (width + w > maxWidth) break;
    width += w;
    out += char;
  }
  return out;
}

export function truncate(text, maxWidth, ellipsis = "…") {
  const plain = stripAnsi(String(text));
  if (visibleWidth(plain) <= maxWidth) return plain;
  if (maxWidth <= 0) return "";
  const markWidth = visibleWidth(ellipsis);
  if (maxWidth <= markWidth) return ellipsis.slice(0, maxWidth);
  return sliceWidth(plain, maxWidth - markWidth) + ellipsis;
}

/* Same as truncate, but keeps SGR color sequences and closes them with a
 * reset. Used as a final guard so one long line can never wrap the layout. */
export function truncateAnsi(text, maxWidth, ellipsis = "…") {
  const source = String(text);
  if (visibleWidth(source) <= maxWidth) return source;
  if (maxWidth <= 0) return "";
  const markWidth = visibleWidth(ellipsis);
  const target = Math.max(0, maxWidth - markWidth);
  let width = 0;
  let index = 0;
  let out = "";
  let styled = false;

  while (index < source.length) {
    if (source[index] === "\x1b") {
      const match = source.slice(index).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (match) {
        out += match[0];
        styled = true;
        index += match[0].length;
        continue;
      }
    }
    const cp = source.codePointAt(index);
    const char = String.fromCodePoint(cp);
    const charW = charWidth(cp);
    if (width + charW > target) break;
    out += char;
    width += charW;
    index += char.length;
  }

  if (maxWidth <= markWidth) return ellipsis.slice(0, maxWidth);
  return out + ellipsis + (styled ? "\x1b[0m" : "");
}

/* Wrap plain text to a display width. Words longer than the line are cut. */
export function wrap(text, width) {
  const safeWidth = Math.max(1, Math.floor(width));
  const paragraphs = String(text).replace(/\r\n?/g, "\n").split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.replace(/\t/g, "    ").split(/ +/).filter((word) => word.length);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (let word of words) {
      let wordWidth = visibleWidth(word);
      if (line && lineWidth + 1 + wordWidth > safeWidth) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      if (!line && wordWidth > safeWidth) {
        while (wordWidth > safeWidth) {
          const head = sliceWidth(word, safeWidth);
          if (!head) break;
          lines.push(head);
          word = word.slice(head.length);
          wordWidth = visibleWidth(word);
        }
        line = word;
        lineWidth = wordWidth;
        continue;
      }
      lineWidth += line ? 1 + wordWidth : wordWidth;
      line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

export function padEnd(text, width) {
  const pad = Math.max(0, width - visibleWidth(text));
  return text + " ".repeat(pad);
}

export function center(text, width) {
  const plainWidth = visibleWidth(text);
  if (plainWidth >= width) return text;
  const left = Math.floor((width - plainWidth) / 2);
  return " ".repeat(left) + text;
}

/* Two plain-text columns, each passed through its own style function. The
 * right column is dropped if there is no room for it. */
export function twoColumn(left, right, width, leftStyle = (s) => s, rightStyle = (s) => s) {
  const l = truncate(left, width);
  if (!right) return leftStyle(padEnd(l, width));
  const rightRoom = width - visibleWidth(l) - 1;
  if (rightRoom < 8) return leftStyle(padEnd(l, width));
  const r = truncate(right, rightRoom);
  const gap = Math.max(1, width - visibleWidth(l) - visibleWidth(r));
  return leftStyle(l) + " ".repeat(gap) + rightStyle(r);
}

/* ---------------------------------------------------------------- colors -- */

const CODES = {
  accent: "38;5;208",
  accentBold: "1;38;5;208",
  green: "38;5;71",
  greenBold: "1;38;5;71",
  red: "38;5;203",
  redBold: "1;38;5;203",
  amber: "38;5;214",
  amberBold: "1;38;5;214",
  dim: "38;5;244",
  faint: "38;5;240",
  bold: "1",
  inverse: "7",
};

export function makeTheme(enabled = true) {
  const paint = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return {
    enabled,
    accent: paint(CODES.accent),
    accentBold: paint(CODES.accentBold),
    green: paint(CODES.green),
    greenBold: paint(CODES.greenBold),
    red: paint(CODES.red),
    redBold: paint(CODES.redBold),
    amber: paint(CODES.amber),
    amberBold: paint(CODES.amberBold),
    dim: paint(CODES.dim),
    faint: paint(CODES.faint),
    bold: paint(CODES.bold),
    inverse: paint(CODES.inverse),
    reset: enabled ? "\x1b[0m" : "",
  };
}

/* --------------------------------------------------------------- spinner -- */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(now = Date.now()) {
  return SPINNER[Math.floor(now / 90) % SPINNER.length];
}

/* ------------------------------------------------------------------ audio -- */

export function int16ToFloat32(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return out;
}

export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function peak(samples) {
  let value = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > value) value = abs;
  }
  return value;
}

export function toDecibels(value) {
  return clamp(20 * Math.log10(Math.max(value, 1e-7)), -60, 0);
}
