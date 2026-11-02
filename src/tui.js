/*
 * The whole interface. render() is pure: it takes a view and a terminal size
 * and returns exactly `height` lines, so the same function drives the real
 * TUI and the snapshot tests.
 */

import {
  center,
  clamp,
  formatBytes,
  formatClock,
  formatDuration,
  formatRealtime,
  formatSpeed,
  formatTime,
  makeTheme,
  padEnd,
  spinner,
  stripAnsi,
  truncate,
  truncateAnsi,
  twoColumn,
  visibleWidth,
  wrap,
} from "./util.js";

export const MIN_WIDTH = 48;
export const MIN_HEIGHT = 15;
const MARGIN = 2;
const MAX_CONTENT = 104;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BARS = "▁▂▃▄▅▆▇█";

export function render(view, width, height, theme = makeTheme(true)) {
  const t = theme;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return tooSmall(width, height, t);
  }

  const cw = Math.min(width - MARGIN * 2, MAX_CONTENT);
  const bodyBudget = height - 6;
  const body = bodyFor(view, cw, bodyBudget, t);
  const lines = [
    header(view, cw, t),
    t.faint("─".repeat(cw)),
    "",
    ...fitBody(body, bodyBudget),
    "",
    t.faint("─".repeat(cw)),
    footer(view, cw, t),
  ];
  const margin = " ".repeat(MARGIN);
  return lines
    .slice(0, height)
    .map((line) => (line ? margin + truncateAnsi(line, cw) : ""));
}

export function renderToString(view, width = 100, height = 28, { color = false } = {}) {
  const theme = makeTheme(color);
  const lines = render(view, width, height, theme);
  return color ? lines.join("\n") : lines.map(stripAnsi).join("\n");
}

/* ------------------------------------------------------------- furniture -- */

function header(view, cw, t) {
  const leftPlain = "◆ myna";
  const rightPlain = view.demo ? "demo mode" : "100% local";
  const left = `${t.accent("◆")} ${t.bold("myna")}`;
  if (visibleWidth(leftPlain) + visibleWidth(rightPlain) + 2 > cw) return left;
  const gap = cw - visibleWidth(leftPlain) - visibleWidth(rightPlain);
  const right = view.demo ? t.amber(rightPlain) : t.dim(rightPlain);
  return left + " ".repeat(gap) + right;
}

function footer(view, cw, t) {
  const hintOptions = hintsFor(view);
  let best = hintOptions[hintOptions.length - 1] ?? "";
  const status = statusFor(view, t);
  const statusWidth = status ? visibleWidth(status.text) : 0;

  for (const option of hintOptions) {
    const room = cw - visibleWidth(option) - 1;
    if (room >= statusWidth || (!status && visibleWidth(option) <= cw)) {
      best = option;
      break;
    }
  }

  if (visibleWidth(best) > cw) best = truncate(best, cw);
  if (!status) return t.dim(padEnd(best, cw));

  const room = cw - visibleWidth(best) - 1;
  if (room < 8) return t.dim(best);
  const text = truncate(status.text, room);
  const gap = cw - visibleWidth(best) - visibleWidth(text);
  return t.dim(best) + " ".repeat(Math.max(1, gap)) + status.style(text);
}

function hintsFor(view) {
  if (view.help) return ["? / esc close", "? close"];
  if (view.phase === "boot") return ["esc quit", "esc quit"];
  if (view.phase === "error") {
    return view.error?.retry
      ? ["r retry · q quit", "r retry · q quit", "q quit"]
      : ["q quit", "q quit"];
  }
  if (view.phase === "arming") return ["esc cancel", "esc cancel"];
  if (view.phase === "recording") {
    return view.recording?.source === "shift"
      ? ["release shift to send · esc cancel", "release shift · esc", "esc"]
      : ["space stop · esc cancel", "space stop · esc", "esc"];
  }
  if (view.phase === "transcribing") return ["wait… · q quit", "wait…", "q quit"];
  if (view.kitty) {
    return [
      "hold shift · space talk · ↑↓ history · enter copy · ? keys · q quit",
      "hold shift · space talk · ↑↓ history · ? keys · q quit",
      "hold shift · space talk · ? keys · q quit",
      "space talk · ? keys · q quit",
      "space · q",
    ];
  }
  return [
    "space talk · ↑↓ history · enter copy · ? keys · q quit",
    "space talk · ↑↓ history · ? keys · q quit",
    "space talk · ? keys · q quit",
    "space talk · q quit",
    "space · q",
  ];
}

function statusFor(view, t) {
  const toast = view.toast && view.toast.until > Date.now() ? view.toast : null;
  if (toast) {
    const style = toast.tone === "ok" ? t.green : toast.tone === "error" ? t.red : t.amber;
    return { text: toast.text, style };
  }
  if (view.demo) return { text: "demo", style: t.amber };

  let text = "";
  let style = t.dim;
  if (view.phase === "recording") {
    text = "mic live";
    style = t.red;
  } else if (view.phase === "arming") {
    text = "mic starting";
    style = t.amber;
  } else if (view.mic.permission === "denied" || view.mic.permission === "restricted") {
    text = "mic off";
    style = t.red;
  } else if (view.mic.warm) {
    text = "mic warm";
    style = t.green;
  } else if (view.mic.state === "preparing") {
    text = "mic preparing";
    style = t.amber;
  } else if (view.mic.state === "error") {
    text = "mic unavailable";
    style = t.red;
  } else if (view.mic.permission === "notDetermined") {
    text = "mic ask";
    style = t.amber;
  } else {
    text = "mic cold";
    style = t.dim;
  }

  if (view.model.state === "ready") text += ` · ${view.model.device ?? "CPU"}`;
  return { text, style };
}

function fitBody(body, budget) {
  if (body.length > budget) {
    if (budget <= 1) return [""];
    return body.slice(0, budget);
  }
  return [...body, ...Array(budget - body.length).fill("")];
}

function tooSmall(width, height, t) {
  const lines = Array.from({ length: height }, () => "");
  const messages = [
    t.bold("terminal too small"),
    t.dim(`need at least ${MIN_WIDTH} × ${MIN_HEIGHT} cells`),
    "",
    t.faint(`${width} × ${height}`),
  ];
  const start = Math.max(0, Math.floor((height - messages.length) / 2));
  for (let i = 0; i < messages.length && start + i < height; i++) {
    lines[start + i] = center(messages[i], width);
  }
  return lines;
}

/* ---------------------------------------------------------------- screens -- */

function bodyFor(view, cw, budget, t) {
  if (view.help) return helpBody(view, cw, budget, t);
  if (view.phase === "error") return errorBody(view, cw, budget, t);
  if (view.phase === "recording" || view.phase === "arming") {
    return liveBody(view, cw, budget, t, false);
  }
  if (view.phase === "transcribing") return liveBody(view, cw, budget, t, true);
  if (view.phase === "boot" || view.model.state !== "ready") return bootBody(view, cw, budget, t);
  return idleBody(view, cw, budget, t);
}

function bootBody(view, cw, budget, t) {
  const lines = [];
  const downloading = view.model.state === "downloading" || view.model.state === "checking";
  lines.push(t.accentBold(downloading ? "SETTING UP" : "STARTING"));
  lines.push(t.dim("Myna · on-device speech recognition"));
  lines.push("");

  const files = view.model.files ?? [];
  for (const file of files) {
    lines.push(fileLine(file, view, cw, t));
  }

  lines.push("");
  if (view.model.state === "error") {
    lines.push(`${t.red("▲")} ${t.redBold("recognizer")}  ${truncate(view.model.error ?? "failed to load", cw - 14)}`);
  } else if (view.model.state === "loading") {
    lines.push(
      `${t.accent(spinner())} ${t.dim(view.model.message ? `recognizer · ${view.model.message}` : "loading the recognizer…")}`
    );
  } else if (view.model.state === "ready") {
    lines.push(
      `${t.green("✓")} recognizer ${t.dim(
        `· ${view.model.device} · ${formatDuration((view.model.loadMs ?? 0) / 1000)}`
      )}`
    );
  } else {
    lines.push(`${t.faint("·")} ${t.dim("recognizer waiting for the weights")}`);
  }

  lines.push(micLine(view, cw, t));

  if (budget > lines.length + 4) {
    lines.push("");
    const remaining = view.model.total ? ` · ${formatBytes(view.model.total)} total` : "";
    lines.push(t.faint(`weights in ${view.paths?.models ?? "~/.myna/models"}${remaining}`));
    if (downloading) {
      lines.push(t.faint("first run only · downloads resume where they stopped"));
    }
  }

  if (view.mic.permission === "denied") {
    lines.push("");
    lines.push(t.red("▲ microphone access is off"));
    lines.push(...wrap("Allow your terminal in System Settings → Privacy & Security → Microphone, then press r.", cw).map((line) => t.amber(line)));
  }
  return lines.slice(0, budget);
}

function fileLine(file, view, cw, t) {
  const done = file.size > 0 && file.loaded >= file.size;
  const started = file.loaded > 0;
  const active = view.model.activeFile === file.name;
  const size = formatBytes(file.size);
  const nameWidth = Math.min(32, Math.max(16, Math.floor(cw * 0.32)));
  const name = padEnd(truncate(file.name, nameWidth), nameWidth);

  if (done) {
    return `${t.green("✓")} ${t.dim(name)} ${t.faint(size)}`;
  }
  if (!started) {
    return `${t.faint("·")} ${t.dim(name)} ${t.faint(size)}`;
  }

  const ratio = file.size ? clamp(file.loaded / file.size, 0, 1) : 0;
  const percent = `${Math.floor(ratio * 100)}%`.padStart(4);
  const showSpeed = active && view.model.speed > 0;
  const speed = showSpeed ? `  ${formatSpeed(view.model.speed)}` : "";
  const bytes = cw >= 78 ? `${formatBytes(file.loaded)} / ${size}` : "";
  const reserved = nameWidth + 2 + (bytes ? 23 : 0) + 6 + (speed ? 12 : 0);
  const barWidth = clamp(cw - reserved, 8, 34);
  const filled = Math.round(barWidth * ratio);
  const bar = t.accent("█".repeat(filled)) + t.faint("░".repeat(barWidth - filled));
  const label = active ? t.accent(name) : t.dim(name);
  const detail = bytes ? `${t.dim(bytes.padEnd(22))} ` : "";
  return `${t.accent("▸")} ${label} ${detail}${bar} ${t.dim(percent)}${t.faint(speed)}`;
}

function micLine(view, cw, t) {
  const mic = view.mic;
  if (mic.state === "preparing") {
    return `${t.accent(spinner())} ${t.dim("microphone · building the helper (one time)…")}`;
  }
  if (mic.state === "error") {
    return `${t.red("▲")} ${t.redBold("microphone")}  ${truncate(mic.message ?? "unavailable", cw - 16)}`;
  }
  if (mic.permission === "denied" || mic.permission === "restricted") {
    return `${t.amber("▲")} ${t.amberBold("microphone")}  ${t.amber("permission needed")}`;
  }

  const name = truncate(mic.name ?? "microphone", Math.max(8, cw - 24));
  if (mic.permission === "notDetermined") {
    return `${t.faint("·")} ${t.dim(`microphone · ${name}`)} ${t.faint("· will ask when you first speak")}`;
  }
  const warm = mic.warm ? t.green(" · warm") : "";
  const suffix = mic.mode === "command" ? t.faint(" · external") : "";
  return `${t.green("✓")} ${t.dim(`microphone · ${name}`)}${warm}${suffix}`;
}

function idleBody(view, cw, budget, t) {
  const lines = [];
  const banner = micBanner(view, cw, t);
  if (banner.length) {
    lines.push(...banner);
    if (lines.length < budget) lines.push("");
  }

  if (!view.history.length) {
    const block = welcomeBlock(view, cw, t);
    const remaining = Math.max(0, budget - lines.length);
    const top = Math.max(0, Math.floor((remaining - block.length) / 2));
    lines.push(...Array(top).fill(""), ...block);
    return lines;
  }

  const entry = view.history[clamp(view.selected, 0, view.history.length - 1)];
  const count = `${view.selected + 1} / ${view.history.length}`;
  lines.push(twoColumn("TRANSCRIPT", view.selected === 0 ? "latest" : count, cw, t.dim, t.faint));

  const inner = Math.max(8, cw - 4);
  const text = entry.text.replace(/\s+/g, " ").trim();
  const wrapped = wrap(text, inner);
  const metricsRoom = 4 + (view.history.length > 1 ? 4 : 0);
  const textBudget = clamp(budget - lines.length - metricsRoom, 1, 12);
  const visible = wrapped.slice(0, textBudget);
  const cut = wrapped.length > visible.length;
  if (cut && visible.length) {
    visible[visible.length - 1] = truncate(`${visible[visible.length - 1]} …`, inner, "…");
  }

  lines.push(t.faint(`┌${"─".repeat(inner + 2)}┐`));
  for (const line of visible) {
    lines.push(t.faint("│") + " " + padEnd(line, inner) + " " + t.faint("│"));
  }
  lines.push(t.faint(`└${"─".repeat(inner + 2)}┘`));

  const meta = metaText(entry);
  const copy = copyText(view, t);
  lines.push(twoColumn(meta, copy?.text ?? "", cw, t.dim, copy?.style ?? t.dim));

  const older = view.history.slice(view.selected + 1);
  if (older.length && lines.length < budget - 2) {
    lines.push("");
    lines.push(twoColumn("EARLIER", `${older.length} more`, cw, t.dim, t.faint));
    const room = budget - lines.length;
    const shown = older.slice(0, Math.max(0, room - (older.length > room ? 1 : 0)));
    for (const item of shown) {
      const stamp = stampFor(item.at);
      const row = `${stamp}  ${item.text.replace(/\s+/g, " ").trim()}`;
      lines.push(t.faint(truncate(row, cw)));
    }
    if (shown.length < older.length && lines.length < budget) {
      lines.push(t.faint("…"));
    }
  }

  return lines;
}

function welcomeBlock(view, cw, t) {
  const lines = [];
  const indent = "  ";
  const kitty = view.kitty;
  lines.push(indent + t.accent("◆"));
  lines.push("");

  if (kitty) {
    lines.push(indent + t.bold("Hold ") + t.accentBold("SHIFT") + t.bold(" and speak"));
    lines.push(indent + t.dim("or press SPACE to start and stop"));
  } else {
    lines.push(indent + t.bold("Press ") + t.accentBold("SPACE") + t.bold(" and speak"));
  }

  lines.push("");
  for (const line of wrap("Release to transcribe. The text goes straight to your clipboard.", cw - 4)) {
    lines.push(indent + t.dim(line));
  }
  lines.push("");
  for (const line of wrap("Audio and text stay on this machine. No account, no API, no network.", cw - 4)) {
    lines.push(indent + t.faint(line));
  }

  if (!kitty) {
    lines.push("");
    for (const line of wrap(
      "This terminal does not report bare Shift presses. Ghostty, kitty, WezTerm and iTerm2 do.",
      cw - 4
    )) {
      lines.push(indent + t.amber(line));
    }
  }

  if (view.demo) {
    lines.push("");
    lines.push(indent + t.amber("Demo mode: the microphone and recognizer are simulated."));
  }

  const mic = view.mic;
  const micName = mic.name ?? "microphone";
  const micText =
    mic.permission === "denied"
      ? "microphone · permission needed"
      : mic.state === "error"
        ? "microphone · unavailable"
        : mic.warm
          ? `microphone · ${micName} · warm`
          : mic.state === "preparing"
            ? "microphone · preparing"
            : `microphone · ${micName}`;
  lines.push("");
  lines.push(indent + t.faint(micText));
  lines.push(
    indent +
      t.faint(
        view.model.state === "ready"
          ? `recognizer · ${view.model.device ?? "CPU"} · Parakeet Redux`
          : "recognizer · loading"
      )
  );
  return lines;
}

function liveBody(view, cw, budget, t, transcribing) {
  const data = transcribing ? view.transcribing : view.recording;
  if (!data) return [];
  const now = Date.now();
  const elapsed = now - (data.startedAt ?? now);
  const lines = [];
  const pulse = Math.floor(now / 450) % 2 === 0;

  if (transcribing) {
    const label = `${t.accentBold("◐ TRANSCRIBING")} ${t.accent(spinner(now))}`;
    lines.push(rightAligned(label, "◐ TRANSCRIBING ⠋", formatClock(elapsed), cw, t));
  } else if (view.phase === "arming") {
    const label = `${t.amberBold("◌ WARMING MIC")} ${t.amber(spinner(now))}`;
    lines.push(rightAligned(label, "◌ WARMING MIC ⠋", formatClock(elapsed), cw, t));
  } else {
    const dot = pulse ? t.redBold("●") : t.red("●");
    const label = `${dot} ${t.redBold("RECORDING")}`;
    lines.push(rightAligned(label, "● RECORDING", formatClock(elapsed), cw, t));
  }

  lines.push("");
  lines.push(waveform(transcribing ? data.levels ?? [] : view.recording?.levels ?? [], view, cw, t, transcribing));
  lines.push("");

  if (transcribing) {
    const bits = [];
    if (data.encodeMs > 0) bits.push(`encoder ${formatDuration(data.encodeMs / 1000)}`);
    if (data.decodeMs > 0) bits.push(`decoder ${formatDuration(data.decodeMs / 1000)}`);
    if (data.of > 1) bits.push(`chunk ${Math.max(1, data.done)} / ${data.of}`);
    if (bits.length) lines.push(t.dim(bits.join(" · ")));
    if (data.partialText) {
      for (const line of wrap(truncate(data.partialText, cw * 2), cw).slice(0, 2)) {
        lines.push(t.faint(line));
      }
    }
  } else if (view.phase === "arming") {
    const message = view.mic?.message || "the microphone is starting · hold the key";
    lines.push(t.amber(message));
  } else {
    lines.push(
      t.dim(
        view.recording?.source === "shift"
          ? "release SHIFT to transcribe"
          : "press SPACE to stop"
      )
    );
  }

  const top = Math.max(0, Math.floor((budget - lines.length) / 2));
  return [...Array(top).fill(""), ...lines];
}

function rightAligned(left, leftPlain, right, cw, t) {
  const gap = Math.max(1, cw - visibleWidth(leftPlain) - visibleWidth(right));
  return left + " ".repeat(gap) + t.dim(right);
}

function waveform(levels, view, cw, t, frozen) {
  const bars = clamp(cw - 18, 12, 64);
  const recent = levels.slice(-bars);
  const padding = Math.max(0, bars - recent.length);
  let out = "";
  for (let i = 0; i < padding; i++) out += t.faint("·");
  for (const db of recent) {
    if (db <= -56) {
      out += t.faint("·");
      continue;
    }
    const index = clamp(Math.floor(((db + 56) / 56) * BARS.length), 0, BARS.length - 1);
    const char = BARS[index];
    out += db > -6 ? t.red(char) : db > -20 ? t.accent(char) : t.green(char);
  }
  const peak = view.recording?.peakDb ?? view.transcribing?.peakDb;
  const right = peak !== undefined ? `${Math.round(peak)} dB` : "";
  const gap = Math.max(1, cw - bars - visibleWidth(right));
  return out + " ".repeat(gap) + (right ? t.faint(right) : "");
}

function metaText(entry) {
  const bits = [];
  if (entry.audioSec) bits.push(`${formatDuration(entry.audioSec)} audio`);
  if (entry.ms) bits.push(formatDuration(entry.ms / 1000));
  if (entry.audioSec && entry.ms) {
    const realtime = formatRealtime(entry.audioSec, entry.ms);
    if (realtime) bits.push(realtime);
  }
  return bits.join(" · ");
}

function copyText(view, t) {
  const copy = view.copy;
  if (!copy || copy.state === null || copy.index !== view.selected) return null;
  if (copy.state === "ok") {
    return { text: copy.method === "terminal" ? "sent to terminal ✓" : "copied ✓", style: t.green };
  }
  if (copy.state === "error") return { text: "copy failed · enter", style: t.red };
  if (copy.state === "off") return { text: "copy off", style: t.faint };
  return null;
}

function micBanner(view, cw, t) {
  const lines = [];
  const mic = view.mic;
  if (mic.permission === "denied" || mic.permission === "restricted") {
    lines.push(`${t.redBold("▲ microphone access is off")}`);
    for (const line of wrap(
      "Allow your terminal in System Settings → Privacy & Security → Microphone, then press r to check again.",
      cw
    )) {
      lines.push(t.amber(line));
    }
  } else if (mic.state === "error" && mic.message) {
    lines.push(t.redBold("▲ microphone unavailable"));
    for (const line of wrap(mic.message, cw)) lines.push(t.amber(line));
    if (mic.detail) {
      for (const line of wrap(truncate(mic.detail, 400), cw).slice(0, 3)) lines.push(t.faint(line));
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ help -- */

function helpBody(view, cw, budget, t) {
  const lines = [t.accentBold("KEYS"), t.faint("─".repeat(cw)), ""];
  const rows = [
    ["space", "start / stop recording"],
    ["shift (hold)", "push-to-talk in terminals that report key releases"],
    ["enter", "copy the selected transcript again"],
    ["↑ / ↓", "browse earlier transcripts"],
    ["esc", "cancel a recording"],
    ["?", "close this panel"],
    ["q / ctrl-c", "quit"],
  ];
  const keyWidth = 15;
  for (const [key, description] of rows) {
    lines.push("  " + t.accent(padEnd(key, keyWidth)) + t.dim(truncate(description, cw - keyWidth - 2)));
  }
  lines.push("");
  if (!view.kitty) {
    for (const line of wrap(
      "This terminal does not report bare Shift presses, so use SPACE. Ghostty, kitty, WezTerm and iTerm2 support hold-to-talk.",
      cw
    )) {
      lines.push(t.amber(line));
    }
    lines.push("");
  }
  for (const line of wrap(
    "The microphone stays warm for two minutes after a dictation so the next one starts instantly. Audio is only transcribed while you hold the key. Nothing leaves this machine.",
    cw
  )) {
    lines.push(t.faint(line));
  }
  return lines.slice(0, budget);
}

function errorBody(view, cw, budget, t) {
  const error = view.error ?? {};
  const lines = [];
  lines.push(t.redBold(`▲ ${error.title ?? "SOMETHING WENT WRONG"}`));
  lines.push("");
  for (const line of wrap(error.message ?? "An unexpected error occurred.", cw)) {
    lines.push(t.bold(line));
  }
  if (error.hint) {
    lines.push("");
    for (const line of wrap(error.hint, cw)) lines.push(t.amber(line));
  }
  if (error.detail) {
    lines.push("");
    for (const line of wrap(truncate(error.detail, 1200), cw).slice(0, Math.max(1, budget - lines.length))) {
      lines.push(t.faint(line));
    }
  }
  return lines.slice(0, budget);
}

/* ---------------------------------------------------------------- stamps -- */

function stampFor(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return formatTime(timestamp);
  if (date.getFullYear() === now.getFullYear()) return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
