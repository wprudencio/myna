/*
 * Raw keyboard input.
 *
 * Terminals do not normally report a bare Shift press, so hold-to-talk needs
 * the kitty keyboard protocol: query support, then ask for event types, all
 * keys as escape codes, and associated text. When the terminal does not
 * answer, the reader falls back to plain UTF-8 and the app offers Space as a
 * toggle instead.
 */

import { EventEmitter } from "node:events";

const ESC = 0x1b;
const BEL = 0x07;
const BRACKET_START = "\x1b[200~";
const BRACKET_END = "\x1b[201~";

const MODIFIER_KEYS = new Map([
  [57441, ["shift", "left"]],
  [57442, ["control", "left"]],
  [57443, ["alt", "left"]],
  [57444, ["super", "left"]],
  [57445, ["hyper", "left"]],
  [57446, ["meta", "left"]],
  [57447, ["shift", "right"]],
  [57448, ["control", "right"]],
  [57449, ["alt", "right"]],
  [57450, ["super", "right"]],
  [57451, ["hyper", "right"]],
  [57452, ["meta", "right"]],
]);

function utf8Length(byte) {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function parseKitty(params) {
  const fields = params.split(";");
  const keyCode = Number((fields[0] || "").split(":")[0]);
  if (!Number.isFinite(keyCode)) return null;
  const modField = fields[1] ?? "";
  const [modsPart, eventPart] = modField.split(":");
  const rawMods = Number(modsPart || "1") - 1;
  const event = Number(eventPart || "1");
  let text = "";
  if (fields[2]) {
    for (const part of fields[2].split(":")) {
      if (!part) continue;
      const cp = Number(part);
      if (Number.isFinite(cp) && cp > 0) {
        try {
          text += String.fromCodePoint(cp);
        } catch {}
      }
    }
  }
  return {
    keyCode,
    event: [1, 2, 3].includes(event) ? event : 1,
    text,
    mods: {
      shift: Boolean(rawMods & 1),
      alt: Boolean(rawMods & 2),
      ctrl: Boolean(rawMods & 4),
      super: Boolean(rawMods & 8),
    },
  };
}

export class KeyReader extends EventEmitter {
  constructor(stdin, { kitty = true, stdout = process.stdout } = {}) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.wantKitty = kitty;
    this.kitty = false;
    this.raw = false;
    this.detecting = false;
    this.buffer = Buffer.alloc(0);
    this.pasting = false;
    this.escapeTimer = null;
    this.destroyed = false;
    this._onData = (chunk) => this._feed(chunk);
    this._onError = (error) => this.emit("error", error);
  }

  async start() {
    if (!this.stdin.isTTY) throw new Error("keyboard input needs a TTY");
    this.stdin.setRawMode(true);
    this.raw = true;
    this.stdin.resume();
    this.stdin.on("data", this._onData);
    this.stdin.on("error", this._onError);

    if (this.wantKitty) {
      const supported = await this._detectKitty();
      if (supported) {
        this.kitty = true;
        this._write("\x1b[>27u");
        this.emit("kitty", true);
      }
    }
    this.detecting = false;
    this._pump();
  }

  _write(text) {
    try {
      this.stdout.write(text);
    } catch {}
  }

  _detectKitty() {
    return new Promise((resolve) => {
      this.detecting = true;
      let settled = false;
      const finish = (supported) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (supported) {
          const text = this.buffer.toString("latin1");
          const match = text.match(/\x1b\[\?(\d+)u/);
          if (match) {
            const start = match.index;
            this.buffer = Buffer.concat([
              this.buffer.subarray(0, start),
              this.buffer.subarray(start + match[0].length),
            ]);
          }
        }
        resolve(supported);
      };
      const timer = setTimeout(() => finish(false), 180);
      this._detectFinish = finish;
      this._write("\x1b[?u\x1b[c");
    });
  }

  _feed(chunk) {
    if (this.destroyed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.detecting) {
      const match = this.buffer.toString("latin1").match(/\x1b\[\?(\d+)u/);
      if (match) this._detectFinish?.(true);
      return;
    }
    this._pump();
  }

  _scheduleEscape() {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = null;
      if (this.buffer.length === 1 && this.buffer[0] === ESC) {
        this.buffer = Buffer.alloc(0);
        this._emit("escape", { event: 1, mods: {} });
      }
    }, 30);
  }

  _pump() {
    if (this.destroyed || this.detecting) return;
    if (this.escapeTimer && !(this.buffer.length === 1 && this.buffer[0] === ESC)) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }

    while (this.buffer.length) {
      if (this.pasting) {
        const text = this.buffer.toString("latin1");
        const end = text.indexOf(BRACKET_END);
        if (end < 0) {
          /* Keep a short tail in case the end marker is split across reads. */
          if (this.buffer.length > 6) this.buffer = this.buffer.subarray(this.buffer.length - 6);
          return;
        }
        this.buffer = this.buffer.subarray(end + BRACKET_END.length);
        this.pasting = false;
        this.emit("paste", { text: text.slice(0, end) });
        continue;
      }

      const first = this.buffer[0];

      if (first === ESC) {
        if (this.buffer.length === 1) {
          this._scheduleEscape();
          return;
        }
        const second = this.buffer[1];

        if (second === 0x5b /* [ */) {
          let final = -1;
          for (let i = 2; i < this.buffer.length; i++) {
            const byte = this.buffer[i];
            if (byte >= 0x40 && byte <= 0x7e) {
              final = i;
              break;
            }
          }
          if (final < 0) {
            if (this.buffer.length > 2048) this.buffer = Buffer.alloc(0);
            return;
          }
          const sequence = this.buffer.subarray(0, final + 1);
          const params = sequence.subarray(2, sequence.length - 1).toString("latin1");
          const kind = String.fromCharCode(sequence[sequence.length - 1]);
          this.buffer = this.buffer.subarray(final + 1);
          this._handleCsi(params, kind);
          continue;
        }

        if (second === 0x4f /* O */) {
          if (this.buffer.length < 3) return;
          const kind = String.fromCharCode(this.buffer[2]);
          this.buffer = this.buffer.subarray(3);
          if (kind === "A") this._emit("up", { event: 1, mods: {} });
          else if (kind === "B") this._emit("down", { event: 1, mods: {} });
          continue;
        }

        if (second === 0x5d /* ] */) {
          /* OSC reply (title, clipboard, …): consume through BEL or ST. */
          const text = this.buffer.toString("latin1");
          const bel = text.indexOf("\x07");
          const st = text.indexOf("\x1b\\");
          const end = bel >= 0 ? bel + 1 : st >= 0 ? st + 2 : -1;
          if (end < 0) {
            if (this.buffer.length > 8192) this.buffer = Buffer.alloc(0);
            return;
          }
          this.buffer = this.buffer.subarray(end);
          continue;
        }

        if (second === 0x50 /* P */) {
          const text = this.buffer.toString("latin1");
          const end = text.indexOf("\x1b\\");
          if (end < 0) {
            if (this.buffer.length > 8192) this.buffer = Buffer.alloc(0);
            return;
          }
          this.buffer = this.buffer.subarray(end + 2);
          continue;
        }

        /* Alt + a character: consume both and ignore it. */
        const length = utf8Length(second);
        if (this.buffer.length < 2 + length - 1) return;
        this.buffer = this.buffer.subarray(1 + Math.max(1, length));
        continue;
      }

      if (first === 0x03) {
        this.buffer = this.buffer.subarray(1);
        this._emit("ctrl-c", { event: 1, mods: { ctrl: true } });
        continue;
      }

      if (first === 0x0d || first === 0x0a) {
        this.buffer = this.buffer.subarray(1);
        this._emit("enter", { event: 1, mods: {} });
        continue;
      }

      if (first === 0x7f || first === 0x08) {
        this.buffer = this.buffer.subarray(1);
        this._emit("backspace", { event: 1, mods: {} });
        continue;
      }

      if (first === 0x20) {
        this.buffer = this.buffer.subarray(1);
        this._emit("space", { event: 1, mods: {} });
        continue;
      }

      if (first < 0x20) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const length = utf8Length(first);
      if (this.buffer.length < length) return;
      const value = this.buffer.toString("utf8", 0, length);
      this.buffer = this.buffer.subarray(length);
      if (value === "\x1b") continue;
      this._emit("char", { value, event: 1, mods: {} });
    }
  }

  _handleCsi(params, kind) {
    if (kind === "u") {
      if (params.startsWith("?") || params.startsWith(">") || params.startsWith("=")) return;
      const parsed = parseKitty(params);
      if (parsed) this._handleKitty(parsed);
      return;
    }

    if (kind === "~") {
      if (params === "200") {
        this.pasting = true;
        return;
      }
      if (params === "201") {
        this.pasting = false;
        return;
      }
      return;
    }

    if (kind === "A" || kind === "B") {
      /* Functional keys keep the legacy shape, with the event type in the
       * modifier sub-field when event reporting is on: CSI 1;1:3A. */
      const event = Number((params.split(";")[1] || "").split(":")[1]) || 1;
      if (event !== 1) return;
      if (kind === "A") this._emit("up", { event, mods: {} });
      else this._emit("down", { event, mods: {} });
      return;
    }

    /* Everything else (focus events, mouse reports, DA replies, cursor
     * position reports) is noise for this app. */
  }

  _handleKitty({ keyCode, event, text, mods }) {
    const modifier = MODIFIER_KEYS.get(keyCode);
    if (modifier) {
      if (event === 2) return;
      const [name, side] = modifier;
      if (name === "shift") this._emit("shift", { event, side, mods });
      else this._emit("modifier", { event, name, side, mods });
      return;
    }

    if (keyCode === 99 && mods.ctrl && !mods.alt) {
      if (event !== 3) this._emit("ctrl-c", { event, mods });
      return;
    }

    if (event === 3) {
      /* Releases other than Shift are not interesting, but keep the name
       * around so the app could use them later. */
      if (keyCode === 32) this._emit("space", { event, mods });
      return;
    }

    if (keyCode === 32 || text === " ") {
      this._emit("space", { event, mods });
      return;
    }
    if (keyCode === 13) {
      this._emit("enter", { event, mods });
      return;
    }
    if (keyCode === 27) {
      this._emit("escape", { event, mods });
      return;
    }
    if (keyCode === 127 || keyCode === 8) {
      this._emit("backspace", { event, mods });
      return;
    }

    let value = text;
    if (!value && keyCode >= 32 && keyCode < 0x110000) {
      try {
        value = String.fromCodePoint(keyCode);
      } catch {}
    }
    if (value) this._emit("char", { value, event, mods });
  }

  _emit(name, payload) {
    this.emit(name, payload);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    if (this.kitty) this._write("\x1b[<u");
    this.stdin.removeListener("data", this._onData);
    this.stdin.removeListener("error", this._onError);
    if (this.raw) {
      try {
        this.stdin.setRawMode(false);
      } catch {}
    }
    this.stdin.pause();
  }
}
