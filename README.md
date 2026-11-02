<p align="center">
  <img src="assets/myna-icon.png" width="110" alt="Myna">
</p>

<h1 align="center">Myna</h1>

<p align="center">
  <b>Speak. It's in your clipboard.</b><br>
  Push-to-talk dictation for the terminal and the macOS menu bar.<br>
  Powered by <a href="https://huggingface.co/mrfakename/parakeet-redux-ONNX">Parakeet Redux</a>
  and ONNX Runtime.
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-ff5a1f">
  <img alt="runtime" src="https://img.shields.io/badge/runtime-ONNX%20Runtime-3fa66a">
  <img alt="model" src="https://img.shields.io/badge/model-Parakeet%20Redux-14211f">
</p>

![Myna](assets/myna-hero.png)

Myna is a local speech-to-text tool with two faces:

- **TUI** — a full-screen terminal page with hold-to-talk, history, and clipboard.
- **Menu bar** — a global **⌃⌥Space** shortcut and a menu bar icon. The terminal
  can be closed.

The recognizer is **Parakeet Redux**: three ONNX graphs running through
`onnxruntime-node` on your CPU. Audio and text never leave the machine. The only
network request is the one-time model download.

## Install

Requires **Node 20.3+** and macOS 13+ (Linux works for the TUI; the menu bar is
macOS-only). The first run needs the Xcode command line tools for the small Swift
microphone helper.

```bash
git clone https://github.com/wprudencio/myna.git
cd myna
npm install
```

Put the command on your PATH **without `sudo`**:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/myna.js" ~/.local/bin/myna
```

If `~/.local/bin` is not already on your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

> `npm link` also works, but only if your npm global prefix is writable. On a
> Homebrew/Node install it is usually root-owned `/usr/local`, which is why the
> symlink above is the recommended path.

> npm may warn that `onnxruntime-node` has an unapproved install script. It is
> harmless: the CPU binaries are included in the package; the script only fetches
> optional CUDA libraries.

You can also run it directly:

```bash
node bin/myna.js
```

## First run

`myna` downloads and prepares everything once:

1. **Parakeet Redux** (~363 MB) into `~/.myna/models` — resumeable.
2. A small **Swift microphone helper** into `~/.myna/bin` (about ten seconds).
3. The ONNX graphs are loaded and warmed up (about two seconds).

The menu bar app is built separately on the first `myna daemon start`:

4. **`~/.myna/Myna.app`** — a tiny accessory app, built locally, no Dock icon.

The model weights are not in the repository. They stream from the Hub the first
time and are cached.

## The TUI

```bash
myna
```

```
  ◆ myna                                                                          100% local
  ──────────────────────────────────────────────────────────────────────────────────────────

  TRANSCRIPT                                                                          latest
  ┌────────────────────────────────────────────────────────────────────────────────────────┐
  │ Remind me to book the flight to Lisbon on Thursday, and to renew my passport before    │
  │ the end of the month.                                                                  │
  └────────────────────────────────────────────────────────────────────────────────────────┘
  7.4s audio · 1.3s · 5.8× realtime                                                 copied ✓

  EARLIER                                                                             2 more
  10:57  The deploy is green. I moved the retry logic into the queue worker and the tests a…
  08:35  Send Sofia the notes from the design review, especially the part about the empty s…

  ──────────────────────────────────────────────────────────────────────────────────────────
  hold shift · space talk · ↑↓ history · enter copy · ? keys · q quit         mic warm · CPU
```

| key | what it does |
| --- | --- |
| **Space** | start / stop recording (works in every terminal) |
| **Shift** (hold) | push-to-talk in terminals that report key releases |
| **Enter** | copy the selected transcript again |
| **↑ / ↓** | browse earlier transcripts |
| **Esc** | cancel a recording, or close a panel |
| **?** | show the key map |
| **q / Ctrl+C** | quit |

The transcript is copied automatically. If native clipboard tools are missing
(for example over SSH), the text is sent to the terminal with OSC 52.

## Hidden mode: menu bar + ⌃⌥Space

```bash
myna daemon start
```

The first start builds the menu bar app, launches it detached, loads the model,
and returns. **The terminal can be closed.** The menu bar icon remains.

Press **⌃⌥Space** once to record and again to stop. The text is transcribed,
copied, and shown in the menu.

**Menu bar icon**

- idle: the Myna bird
- loading: the bird, with the status in the menu
- recording: red bird with a running timer
- transcribing: coral bird with an animated waveform crest
- copied: green flash
- error: warning color, with the reason in the menu

**The menu**

- Start / Stop Recording
- Copy Last Transcript, plus the last transcript preview
- Microphone: warm / cold, and Release Microphone
- Sounds on/off
- Open Microphone Settings
- Restart Daemon when needed
- Quit Myna

The shortcut is a Carbon global hotkey: it works in every app, needs **no
Accessibility permission**, and cannot read other keys. It is configurable if it
collides with another app.

The daemon starts with the microphone **cold**. After a dictation it stays warm
for two minutes so the next one starts instantly. Use **Release Microphone** in
the menu, or start with `--warm 0` for cold every time; `--warm -1` keeps it warm
until you quit.

There is deliberately **no login agent**. Start it when you want it. If you later
want it at login, add `~/.myna/Myna.app` to **System Settings → General → Login
Items** — it reads the same configuration at launch.

Control it from any terminal:

```bash
myna daemon status
myna daemon toggle     # useful as a second shortcut or for testing
myna daemon stop
```

## Hold Shift, and terminal support

A terminal does not normally report a bare Shift press; it only sends the
characters you type. The TUI asks for the **kitty keyboard protocol**, which adds
key press/release events. Terminals that answer get true hold-to-talk; the
others use Space.

Known to work: **Ghostty**, **kitty**, **WezTerm**, **foot**, and recent
**iTerm2**. Terminal.app does not implement the protocol. tmux can pass it
through with recent versions and `extended-keys` enabled.

`--no-kitty` disables it and uses Space only. In kitty mode, pressing Shift and
then another key cancels the accidental recording, so typing a capital letter
does not leave a dictation running.

The menu bar daemon does **not** use bare Shift. It uses the dedicated
**⌃⌥Space** shortcut, so it can never fire while you are typing capitals.

## Microphone permissions

The TUI asks for permission under your **terminal**:

**System Settings → Privacy & Security → Microphone**.

The menu bar daemon asks **separately**, because `Myna.app` is its own app:

**System Settings → Privacy & Security → Microphone → Myna**.

If the prompt was denied, use **Open Microphone Settings** in the Myna menu. The
two permissions are independent.

The default input device is used. Change it in **System Settings → Sound →
Input**.

## Configuration

`~/.myna/config.json` controls the daemon:

```json
{
  "hotkey": "ctrl+alt+space",
  "sounds": true,
  "warmSeconds": 120,
  "recorder": null
}
```

`myna daemon start` writes it. These update it:

```bash
myna daemon start --hotkey cmd+shift+space
myna daemon start --no-sounds
myna daemon start --warm 0          # cold after every dictation
myna daemon start --warm -1         # keep the mic warm until quit
myna daemon start --recorder "cat /tmp/mic.raw"
```

The shortcut needs Ctrl, Option, or Command plus a key: `space`, letters,
digits, `F1`–`F12`, or the arrow keys. Stop and start to apply a changed
shortcut.

`menu` settings live in `menubar.json`; the live state is in `daemon.json`. Both
are internal.

## Cache and history

Everything lives in `~/.myna` unless you pass `--home <dir>`:

```
~/.myna/
  models/          Parakeet Redux, 363 MB, downloaded once
  bin/             compiled microphone helper
  Myna.app/        the menu bar app, built on first `myna daemon start`
  config.json      daemon settings
  menubar.json     launcher details for Myna.app
  daemon.json      live daemon status
  daemon.log       daemon log
  history.json     the last 100 transcripts
  debug.log        only written with --debug
```

`MYNA_HOME` overrides the whole directory. `--no-history` keeps transcripts in
memory for the session but never writes them. `--no-copy` disables automatic
copying; Enter still copies manually.

The model is fetched in 8 MB ranges over several connections. A partial download
keeps its progress and resumes on the next attempt; press `r` on the error screen
to retry.

## Transcribing a file

```bash
myna meeting.m4a                 # text to stdout, also copied
myna meeting.m4a --no-copy       # text to stdout only
myna meeting.m4a --json          # metadata + text
```

Any format `afconvert` (macOS) or `ffmpeg` can decode is converted to 16 kHz
mono. Progress goes to stderr, so stdout stays clean for pipes. `--json` prints:

```json
{
  "text": "…",
  "file": "meeting.m4a",
  "audioSec": 42.3,
  "chunks": 2,
  "encodeMs": 5300,
  "decodeMs": 410,
  "totalMs": 5800,
  "device": "CPU",
  "copied": true
}
```

## Options

TUI and file mode:

```
--home <dir>       cache and history (default ~/.myna)
--cold             stop the microphone between recordings
--warm             keep the microphone warm for the whole session
--no-copy          do not copy automatically
--no-history       do not save transcripts
--no-kitty         do not use the kitty keyboard protocol
--no-color         plain text
--ep <name>        auto, cpu or coreml (default auto = cpu)
--threads <n>      ONNX Runtime CPU threads
--recorder <cmd>   custom recorder, s16le 16 kHz mono on stdout
--file <path>      transcribe an audio file and print it
--json             with --file, print a JSON object
--demo             preview the interface without a model or microphone
--debug            write a log to <home>/debug.log
--help, -h         usage
--version, -v      version
```

Menu bar daemon:

```
myna daemon start     launch the menu bar app and daemon
myna daemon status    show status
myna daemon toggle    toggle recording from the CLI
myna daemon stop      stop the menu bar app and daemon

start options: --home, --hotkey, --warm <seconds>, --sounds/--no-sounds,
               --recorder <cmd>
```

## How it works

```
microphone (AVFoundation / arecord / SoX / ffmpeg)
  └─ s16le 16 kHz mono on stdout
      └─ ring buffer (last 2 s, 250 ms pre-roll)
          └─ ASR service process (onnxruntime-node)
              preprocessor.onnx  → log-mel features
              encoder-model.onnx → 1024-dim frames, one per 80 ms
              decoder_joint      → greedy TDT loop, 5 duration logits
                  └─ vocab.txt   → text
                      └─ pbcopy / wl-copy / xclip / OSC 52

TUI:       terminal input ──────────────────┐
Menu bar:  ⌃⌥Space (Carbon) → Myna.app ─────┴─ JSON lines ↔ Node daemon
```

- **The TUI is a pure render function.** `render()` returns exactly the lines
  for the current terminal size; snapshot tests check every screen.
- **The menu bar app is a small AppKit bundle.** `LSUIElement` (no Dock icon),
  a Carbon global hotkey, and an `NSMicrophoneUsageDescription` so macOS asks
  for the mic as “Myna”. It spawns the Node daemon as a child and talks JSON
  lines over stdin/stdout. LaunchServices owns it; closing the terminal does not
  stop it.
- **ASR lives in its own Node process.** Loading or warming a 344 MB ONNX graph
  would freeze the UI, and terminating a worker thread that owns ONNX Runtime's
  native threads could abort the process. A separate service process keeps the
  UI responsive and can be killed instantly. Both the TUI and the daemon use it.
- **The model download is striped and resumeable.** The encoder is pulled in
  8 MB ranges over eight connections; completed ranges are recorded so a retry
  does not start over.
- **The microphone helper is compiled once.** `native/recorder.swift` converts
  the default input to 16 kHz mono. The cache key includes the source and Swift
  version.
- **Kitty keyboard protocol for hold-to-talk.** The TUI queries support, pushes
  the flags it needs, and pops them on exit. The menu bar daemon avoids the
  problem entirely with a Carbon shortcut.
- **Audio preparation.** Silence is trimmed with an adaptive gate, quiet clips
  are lifted toward full scale, and recordings longer than 30 s are cut at the
  quietest point inside a 20–30 s window.
- **The decoder is greedy TDT.** One joint-network step per 80 ms frame; the
  winning duration moves the frame pointer, like the browser
  [`tts-realtime`](https://github.com/wprudencio/tts-realtime) worker.

## Performance

On the 4-core Intel Mac this was developed on, the model is loaded once and a
6-second clip transcribes in roughly **0.5–0.7 s** when the machine is idle
(about 9–11× realtime), and 1.5–3 s when other work is competing for the CPU.
Long clips scale with the encoder. The model sits at about 350 MB of RAM.

- `--threads 4` (or `2`) can help on a busy laptop; the default is ONNX
  Runtime's choice.
- `--ep coreml` is experimental. On this Intel Mac CoreML compiles but fails at
  execution, so the app probes it and falls back to CPU. `auto` is CPU.
- `onnxruntime-node` is pinned to **1.23.2** because newer releases no longer
  publish a darwin/x64 binary; 1.23.2 also has the arm64 build.
- Do not run the TUI and the menu bar daemon at the same time unless you are
  comfortable with two ~350 MB model copies. Stop one first.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `myna: command not found` | create the `~/.local/bin/myna` symlink above and ensure `~/.local/bin` is on PATH; run `hash -r` or open a new shell |
| `npm link` permission error | use the `~/.local/bin` symlink; do not sudo npm |
| `microphone access is off` in the TUI | enable your terminal in System Settings → Privacy & Security → Microphone, then press `r` |
| `Myna` mic prompt denied | menu bar → **Open Microphone Settings**; this is separate from the terminal |
| menu bar icon is missing | check `myna daemon status`; a menu bar manager may be hiding extras |
| shortcut does nothing | another app owns it; change `hotkey` in `~/.myna/config.json`, then `daemon stop` / `daemon start` |
| daemon will not start | it needs a local GUI session; check `~/.myna/daemon.log` |
| daemon stopped unexpectedly | menu bar → **Restart Daemon**, or `myna daemon stop` / `start` |
| Node was updated | rerun `myna daemon start` so `menubar.json` gets the new Node path |
| `could not build the microphone helper` | install the Xcode command line tools (`xcode-select --install`) or `brew install sox` |
| “This terminal does not report bare Shift presses” | use Space; try Ghostty, kitty, WezTerm, or iTerm2 |
| `nothing came through` | check the input in System Settings → Sound → Input and that it is not muted |
| download failed | press `r`; completed ranges are kept |
| recognizer fails to load | press `r`; if it repeats, remove `~/.myna/models` and restart |
| need more detail | run with `--debug` and read `~/.myna/debug.log` |

`npm test` runs **40** unit/snapshot tests that need no model or microphone.

The developer tools:

```bash
python3 test/pty_demo.py               # legacy Space toggle
python3 test/pty_demo.py --kitty       # hold Shift with kitty key events
python3 test/pty_demo.py --kitty-space # Space with kitty release events
python3 test/pty_real.py               # real TUI boot + microphone banner
python3 test/pty_real_record.py        # full TUI dictation through a FIFO
python3 test/daemon_fifo.py            # headless daemon dictation through a FIFO
npm run render                         # print the TUI screens as text
```

The FIFO tests need the model and a 16 kHz mono WAV. Generate one with:

```bash
say -o /tmp/test.aiff "Hello, this is a test of the Myna speech recognizer."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/test.aiff /tmp/test.wav
MYNA_TEST_WAV=/tmp/test.wav python3 test/pty_real_record.py
MYNA_TEST_WAV=/tmp/test.wav python3 test/daemon_fifo.py
```

## Privacy

The model, microphone audio, transcripts, and clipboard stay on the machine.
The only network request is the first-run model download. History is stored
locally in `~/.myna/history.json`; `--no-history` disables it. The menu bar
microphone stays warm only as described above; the macOS orange indicator is
visible while it is open.

## Credits

- Speech recognition: [mrfakename/parakeet-redux-ONNX](https://huggingface.co/mrfakename/parakeet-redux-ONNX),
  from [moondream/parakeet-redux](https://huggingface.co/moondream/parakeet-redux),
  ONNX export by [eschmidbauer](https://huggingface.co/eschmidbauer/parakeet-redux-onnx).
  Model license: CC-BY-4.0.
- Runtime: [ONNX Runtime](https://github.com/microsoft/onnxruntime) (MIT).
- TDT decoding and download strategy adapted from
  [`tts-realtime`](https://github.com/wprudencio/tts-realtime) (Apache-2.0).
- Microphone helper and menu bar app: Swift, AppKit, AVFoundation, Carbon.
- Keyboard protocol: [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
- Brand art: the Myna bird and hero were generated with Meta Muse via OpenRouter;
  the menu bar mark is drawn directly in Swift.

The code in this repository is MIT licensed; see [LICENSE](LICENSE). The model
weights are not included and remain under their own license.
