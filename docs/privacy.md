# Privacy

Myna is local-first by design.

## What stays on the Mac

- **Microphone audio.** The Swift helper captures it and writes raw PCM to the
  local daemon over a pipe.
- **Transcripts.** Produced by ONNX Runtime on the CPU and written to
  `~/.myna/history.json` (the last 100 entries).
- **Clipboard contents.** Myna writes the transcript with `pbcopy`. It does not
  read the clipboard.
- **The model.** Cached in `~/.myna/models` after the first download.

## What touches the network

Only the first-run model download from `huggingface.co`. Myna checks the Hub's
file list to get sizes, then downloads the four model files in resumable ranges.
There is no account, telemetry, analytics, crash reporting, or update check.

After the model is cached, dictation works with the network disconnected.

## Logs

`~/.myna/daemon.log` contains operational messages such as model loading,
microphone status, and transcription timings. It is a local file and is not sent
anywhere. It may contain short error excerpts.

## Permissions

- **Microphone** — required for dictation. macOS asks the first time.
- **Accessibility** — only if you choose **Type at cursor**. Myna uses it to send
  the standard **⌘V** paste shortcut to the app in front. It does not read your
  keystrokes or inspect other apps.
- **No Full Disk Access** — not requested.

The default **Copy to clipboard** mode does not need Accessibility permission.

## macOS-side storage

The app stores the sound preference and the first-run welcome flag in macOS
`UserDefaults` under `com.wprudencio.myna`.

## Delete your data

Quit Myna, then remove its folder:

```bash
rm -rf ~/.myna
```

This deletes the model, configuration, history, and logs. Remove the app from
Applications separately. To remove the microphone permission record, use
**System Settings → Privacy & Security → Microphone** or, for a full reset:

```bash
tccutil reset Microphone com.wprudencio.myna
```

## Model license

The model weights are not part of the app and remain under the
[Parakeet Redux](https://huggingface.co/moondream/parakeet-redux) license
(CC-BY-4.0). The Myna source is MIT licensed.
