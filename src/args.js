/* Command line parsing and the --help text. */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = pkg.version;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv) {
  const options = {
    home: null,
    file: null,
    json: false,
    copy: true,
    history: true,
    color: !process.env.NO_COLOR,
    kitty: true,
    cold: false,
    warm: false,
    ep: "auto",
    threads: 0,
    recorder: null,
    demo: false,
    debug: false,
    help: false,
    version: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      if (arg === "-h") options.help = true;
      else if (arg === "-v") options.version = true;
      else throw new UsageError(`unknown option ${arg}`);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : null;
    const value = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
      return argv[++i];
    };

    switch (name) {
      case "--home":
        options.home = value();
        break;
      case "--file":
        options.file = value();
        break;
      case "--json":
        options.json = true;
        break;
      case "--copy":
        options.copy = true;
        break;
      case "--no-copy":
        options.copy = false;
        break;
      case "--history":
        options.history = true;
        break;
      case "--no-history":
        options.history = false;
        break;
      case "--color":
        options.color = true;
        break;
      case "--no-color":
        options.color = false;
        break;
      case "--kitty":
        options.kitty = true;
        break;
      case "--no-kitty":
        options.kitty = false;
        break;
      case "--cold":
        options.cold = true;
        break;
      case "--warm":
        options.warm = true;
        break;
      case "--ep": {
        const ep = value();
        if (!["auto", "cpu", "coreml"].includes(ep)) throw new UsageError("--ep must be auto, cpu or coreml");
        options.ep = ep;
        break;
      }
      case "--threads": {
        const raw = value();
        const threads = Number(raw);
        if (!Number.isInteger(threads) || threads < 1) throw new UsageError("--threads needs a positive integer");
        options.threads = threads;
        break;
      }
      case "--recorder":
        options.recorder = value();
        break;
      case "--demo":
        options.demo = true;
        break;
      case "--debug":
        options.debug = true;
        break;
      case "--help":
        options.help = true;
        break;
      case "--version":
        options.version = true;
        break;
      default:
        throw new UsageError(`unknown option ${name}`);
    }
  }

  if (options.cold && options.warm) throw new UsageError("--cold and --warm cannot be used together");
  if (positional.length > 1) throw new UsageError("only one audio file can be transcribed at a time");
  if (positional.length === 1) {
    if (options.file) throw new UsageError("pass the file either as an argument or with --file, not both");
    options.file = positional[0];
  }
  if (options.json && !options.file) throw new UsageError("--json only makes sense with --file");
  if (options.demo && options.file) throw new UsageError("--demo and --file cannot be used together");
  if (options.file && options.recorder) throw new UsageError("--recorder is only used by the interactive view");

  return options;
}

export function helpText() {
  return `myna ${VERSION} — push-to-talk speech to clipboard, entirely on this machine.

Usage
  myna [options]
  myna <audio-file> [--json] [--no-copy]

Keys
  space            start / stop recording
  shift (hold)     push-to-talk, in terminals that report key releases
  enter            copy the selected transcript again
  ↑ / ↓            browse earlier transcripts
  esc              cancel a recording
  ?                show keys
  q / ctrl-c       quit

Background (terminal can be closed)
  myna daemon start     menu bar icon + global shortcut (⌃⌥Space)
  myna daemon status    show daemon state
  myna daemon toggle    toggle recording from the CLI
  myna daemon stop      stop the daemon
  myna daemon --help    daemon options

Options
  --home <dir>       cache and history (default ~/.myna)
  --cold             stop the microphone between recordings
  --warm             keep the microphone warm for the whole session
  --no-copy          do not copy automatically
  --no-history       do not save transcripts
  --no-kitty         do not use the kitty keyboard protocol
  --no-color         plain text
  --ep <name>        auto, cpu or coreml (default auto)
  --threads <n>      ONNX Runtime CPU threads
  --recorder <cmd>   custom recorder: must write s16le 16 kHz mono to stdout
  --file <path>      transcribe an audio file and print it
  --json             with --file, print a JSON object
  --demo             preview the interface without a model or microphone
  --debug            write a log to <home>/debug.log
  --help, -h         this text
  --version, -v      print the version

The first run downloads Parakeet Redux (~363 MB) into ~/.myna/models.
On macOS, a tiny microphone helper is compiled once with swiftc.
Audio never leaves this machine.

Terminals with hold-to-talk: Ghostty, kitty, WezTerm and iTerm2 report bare
Shift presses through the kitty keyboard protocol. Everywhere else, SPACE
starts and stops.`;
}

export { pkg };
