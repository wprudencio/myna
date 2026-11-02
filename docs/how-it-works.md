# How Myna works

Myna is deliberately small. The menu bar app is a native Swift host; the speech
work happens in a bundled Node process; the recognizer runs in a second process so
a slow model never blocks the interface.

```
microphone
  └─ Swift helper (AVFoundation)
      └─ s16le, 16 kHz, mono on stdout
          └─ Node daemon (bundled)
              ├─ ring buffer and silence trimming
              ├─ clipboard and history
              └─ recognizer service (separate process)
                  ├─ preprocessor.onnx   → log-mel features
                  ├─ encoder-model.onnx  → 1024-dim frames
                  └─ decoder_joint       → greedy TDT loop
                      └─ vocab.txt       → text
                          └─ pbcopy
```

## The app bundle

The DMG contains one universal `Myna.app`:

```
Myna.app/Contents/
  MacOS/Myna                     universal Swift menu bar host
  Resources/runtime/node         universal Node.js
  Resources/app/                 JavaScript daemon and ONNX Runtime
  Resources/bin/myna-recorder    universal Swift microphone helper
  Resources/Myna.icns
  Resources/licenses/
```

Both Intel (`x86_64`) and Apple Silicon (`arm64`) slices are present for the
Swift binaries and Node. ONNX Runtime includes its `darwin/x64` and `darwin/arm64`
builds. Nothing is compiled or installed on the user's Mac.

The app is ad-hoc signed. A Developer ID signature and notarization can be added
later without changing the bundle layout.

## Why two processes

Loading a 344 MB ONNX encoder takes a moment, and a long transcription would
freeze a single-process UI. The menu bar host talks JSON lines to the daemon over
stdin/stdout. The daemon starts a separate recognizer process for ONNX Runtime.

If a recording is cancelled or the app quits, the recognizer can be killed
without taking the menu bar UI with it. The menu bar app itself only owns the
status item, the Carbon global hotkey, and the child process.

## The shortcut

Myna uses a Carbon `RegisterEventHotKey` shortcut. It works in every app. The
shortcut itself does not need Accessibility permission; it only receives the
registered combination and cannot read other keys.

The default is **⌃⌥Space**. At launch, the combo is parsed from `config.json` by
the bundled runtime and passed to the Swift host as a Carbon key code and modifier
mask.

The menu's **Shortcut…** picker records a new combination, writes `config.json`,
and re-registers the Carbon hotkey immediately. It pauses the old shortcut while
the picker is open, so pressing the current combination does not start a
dictation.

## Output modes

The daemon always writes the transcript to the clipboard. The Swift host then
decides what to do next:

- **Copy to clipboard** — stop there. You paste with ⌘V.
- **Type at cursor** — send a synthetic **⌘V** with `CGEvent.postToPid` to the app
  that was in front when recording started (or the current frontmost app).

Sending synthetic keystrokes to another app requires Accessibility permission.
Without it, Myna falls back to the clipboard and explains how to enable it. It
never reads your keystrokes or other apps' contents.

## The model

[Parakeet Redux](https://huggingface.co/moondream/parakeet-redux) is a 1.58-bit
version of `parakeet-tdt-0.6b-v3`: a 149M-parameter Parakeet TDT model covering 25
European languages. The ONNX export is
[mrfakename/parakeet-redux-ONNX](https://huggingface.co/mrfakename/parakeet-redux-ONNX).

The app uses:

- `preprocessor.onnx` — 16 kHz waveform to log-mel features
- `encoder-model.onnx` — 344 MB, the acoustic encoder
- `decoder_joint-model.int8.onnx` — quantized decoder and joint network
- `vocab.txt` — token vocabulary

Decoding is greedy TDT: one joint-network step per 80 ms frame, with a duration
head that moves the frame pointer. The code follows the same TDT loop as the
browser `tts-realtime` worker.

## First-run download

The model is not in the repository or the app bundle. On first launch Myna asks
the Hugging Face Hub for the file list and downloads the four files into
`~/.myna/models`.

The encoder is fetched in 8 MB ranges over several connections. Completed ranges
are recorded, so a failed download resumes instead of starting over. The menu bar
shows progress.

After the model is cached, no network request is needed for dictation.

## Audio preparation

The Swift helper converts the default input to **16 kHz mono signed 16-bit PCM**.
The daemon:

- keeps a short ring buffer so a press does not clip the first word
- trims leading and trailing silence with an adaptive gate
- lifts very quiet recordings toward full scale
- cuts recordings longer than 30 seconds at the quietest point in a 20–30 second
  window when preparing a chunk
- limits a single recording to 5 minutes

## Performance

On the Intel Mac used for development, a 6-second clip transcribes in roughly
0.5–0.7 seconds when the machine is idle, about 9–11× realtime. A busy laptop can
take 1.5–3 seconds. The model sits at about 350 MB of RAM while loaded.

The app starts with the microphone cold. After a dictation it stays warm for two
minutes by default, which removes most of the next start latency.

## Privacy boundary

Audio, model files, transcripts, and clipboard contents stay on the Mac. The only
network request is the model download. See [Privacy](privacy.md).
