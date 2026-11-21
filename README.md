<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/myna-icon-inverse.png">
    <img src="assets/myna-icon.png" width="120" alt="Myna">
  </picture>
</p>

<h1 align="center">Myna</h1>

<p align="center">
  <b>Speak. It's in your clipboard.</b><br>
  <sub>A tiny macOS menu bar app for dictation that runs entirely on your Mac.</sub>
</p>

<p align="center">
  <img alt="macOS 13.5+" src="https://img.shields.io/badge/macOS-13.5%2B-0078D6?logo=apple&logoColor=white">
  <img alt="Apple Silicon and Intel" src="https://img.shields.io/badge/arch-apple%20%C2%B7%20intel-14211f">
  <img alt="100% local, offline" src="https://img.shields.io/badge/100%25%20local%20%C2%B7%20offline-3fa66a">
  <img alt="25 languages" src="https://img.shields.io/badge/25-languages-8b5cf6">
  <img alt="Parakeet Redux" src="https://img.shields.io/badge/ASR-Parakeet%20Redux-14b8a6">
  <img alt="version" src="https://img.shields.io/badge/version-1.2.2-ff8a00">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3fa66a">
</p>

<p align="center">
  <a href="https://github.com/wprudencio/myna/releases/latest/download/Myna-1.2.2-arm64.dmg"><b>⬇ Download for Apple Silicon</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/wprudencio/myna/releases/latest/download/Myna-1.2.2-x64.dmg"><b>⬇ Download for Intel</b></a>
  <br>
  <sub>Not sure? <b>Apple menu → About This Mac</b> shows Chip or Processor.</sub>
</p>

## 🎙️ What you get

- **One shortcut.** **⌃⌥Space** starts and stops dictation from any app; change it from the menu.
- **Your choice of output.** The transcript lands on the clipboard — or Myna types it at your cursor.
- **Local speech recognition.** Parakeet Redux on ONNX Runtime, on the CPU. Audio and text never leave the Mac.
- **25 European languages** — Portuguese, English, Spanish, French, German, and 20 more. No language settings; speak naturally.
- **Just a bird in the menu bar.** No Dock icon, no terminal, no account. About 35 MB, plus 363 MB for the model on first launch.

## 🚀 Install

1. Open the DMG for your Mac and drag **Myna** into **Applications**.
2. Open **Myna** — the bird appears in the menu bar and the model downloads in the background.
3. Press **⌃⌥Space**, speak, press it again. The transcript is waiting.

> [!IMPORTANT]
> This build is signed locally, not notarized by Apple. On first open, macOS may
> block it: right-click **Myna** in Applications, choose **Open**, and confirm
> once. After that, double-clicking works normally.

## 🔒 Privacy

Audio, transcripts, history, and the clipboard stay on this Mac — nothing is
sent anywhere, ever. The only network request is the one-time model download.
Details in [docs/privacy.md](docs/privacy.md).

## 📖 Documentation

[Install & first run](docs/install.md) · [Usage](docs/usage.md) ·
[Configuration](docs/configuration.md) · [Troubleshooting](docs/troubleshooting.md) ·
[How it works](docs/how-it-works.md) · [Development](docs/development.md)

## 🧡 Credits

- Speech recognition: [mrfakename/parakeet-redux-ONNX](https://huggingface.co/mrfakename/parakeet-redux-ONNX)
  (CC-BY-4.0), running on [ONNX Runtime](https://github.com/microsoft/onnxruntime) (MIT).
- Menu bar app: Swift, AppKit, Carbon. Daemon and recognizer: Node.js.
- Brand art: drawn in Swift and rendered by `scripts/render-icon.swift`; the
  original hero art was generated with Meta Muse.

Source is MIT ([LICENSE](LICENSE)). Model weights are not bundled and keep
their own license.
