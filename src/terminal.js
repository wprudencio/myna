/* Alternate-screen plumbing. All drawing goes through here so teardown is
 * always in one place. */

export class Terminal {
  constructor(stdout = process.stdout) {
    this.stdout = stdout;
    this.active = false;
    this.lastLines = 0;
  }

  get size() {
    return {
      width: Math.max(1, this.stdout.columns || 80),
      height: Math.max(1, this.stdout.rows || 24),
    };
  }

  enter() {
    if (!this.stdout.isTTY) throw new Error("the interactive view needs a real terminal");
    this.active = true;
    this.stdout.write(
      "\x1b[?1049h" + // alternate screen
        "\x1b[?25l" + // hide cursor
        "\x1b[?2004h" + // bracketed paste
        "\x1b[2J\x1b[H"
    );
  }

  draw(lines) {
    if (!this.active) return;
    const { height } = this.size;
    const visible = lines.slice(0, height);
    const body = visible.join("\x1b[K\r\n");
    try {
      this.stdout.write(`\x1b[?2026h\x1b[H${body}\x1b[K\x1b[J\x1b[?2026l`);
      this.lastLines = visible.length;
    } catch {}
  }

  raw(text) {
    if (!this.active) return;
    try {
      this.stdout.write(text);
    } catch {}
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    try {
      this.stdout.write(
        "\x1b[0m" +
          "\x1b[?2004l" +
          "\x1b[?25h" +
          "\x1b[?1049l"
      );
    } catch {}
  }
}
