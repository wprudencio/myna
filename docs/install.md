# Install Myna

Myna is a self-contained macOS menu bar app. You do not need Node, npm, Xcode, or
any terminal commands to install or use it.

## Requirements

- macOS **13.5** or newer
- An Intel or Apple Silicon Mac
- A microphone
- About **110 MB** for the app and **363 MB** for the speech model
- An internet connection for the first model download

The same DMG works on every supported Mac. There is no separate Intel or M1–M4
download.

## Install

1. Download **`Myna-1.1.0-universal.dmg`** from the
   [latest release](https://github.com/wprudencio/myna/releases/latest).
2. Open the DMG.
3. Drag **Myna** into the **Applications** folder.
4. Open **Myna** from Applications.

Myna has no Dock icon. Look for the small bird in the menu bar.

## First launch

On the first launch Myna shows a short welcome, asks for microphone access when
you first dictate, and downloads the speech model in the background. The menu bar
bird reflects the state:

- the bird while the app is starting
- a progress message while the model downloads
- red while recording
- an animated coral crest while transcribing
- a green flash when the transcript is on the clipboard

The model is cached in `~/.myna/models`. You only download it once. If the
download is interrupted, quit and reopen Myna; completed chunks are kept.

## If macOS blocks the first open

This release is signed locally but **not notarized by Apple yet**. macOS may show:

> “Myna” cannot be opened because the developer cannot be verified.

This is expected. To open it:

1. In **Applications**, right-click **Myna**.
2. Choose **Open**.
3. Confirm **Open** once.

After that, Myna opens normally. A future release can remove this step with an
Apple Developer ID and notarization.

If macOS says the app is damaged, delete it, download the DMG again, and repeat
the steps above. Do not move the app out of Applications while it is running.

## Microphone permission

The first time you dictate, macOS asks for microphone access. Choose **Allow**.

If you denied it, open the Myna menu and choose **Open Microphone Settings…**, or
go to:

**System Settings → Privacy & Security → Microphone → Myna**

Myna uses the current default input device. Change it in
**System Settings → Sound → Input**.

## Accessibility (only for Type at cursor)

The default **Copy to clipboard** mode needs no extra permission.

If you choose **After dictation → Type at cursor**, macOS asks for
**Accessibility** access. This lets Myna press **⌘V** for you.

**System Settings → Privacy & Security → Accessibility → Myna**

The transcript is still copied if the permission is missing, so you can always
paste it manually. The Myna menu has **Open Accessibility Settings…** for this.

## Updating

Download the newer DMG, drag the new **Myna** into Applications, and choose
**Replace** when Finder asks. Your settings and history in `~/.myna` are kept.

Quit Myna from its menu before replacing it.

## Uninstalling

1. Quit Myna from the menu bar.
2. Drag **Myna.app** from Applications to the Trash.
3. Optional: remove the cache, model, and history:

```bash
rm -rf ~/.myna
```

If you added Myna to **Login Items**, remove it in
**System Settings → General → Login Items**.

## What gets installed

| Path | Contents |
| --- | --- |
| `/Applications/Myna.app` | The app, bundled Node runtime, ONNX Runtime, Swift helper |
| `~/.myna/models` | Parakeet Redux model files, about 363 MB |
| `~/.myna/config.json` | Your settings, created when you change something |
| `~/.myna/history.json` | The last 100 transcripts |
| `~/.myna/daemon.log` | The app's diagnostic log |
| `~/.myna/daemon.json` | Live status for this launch |

The app is self-contained. It does not install a command-line tool, edit your
shell profile, or require Homebrew.
