# Development

Myna is a native Swift menu bar host around a small Node daemon and an ONNX
recognizer. The release DMG is built on macOS and contains no developer tools.

## Requirements

- macOS 13.5 or newer
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js 20.3 or newer
- A **universal** Node binary for packaging (`x86_64` + `arm64`)

The official Node macOS installer provides a universal `/usr/local/bin/node`. A
Homebrew Node is usually single-architecture; use the official build or set
`MYNA_NODE_BINARY` to a universal binary.

## Get the source

```bash
git clone https://github.com/wprudencio/myna.git
cd myna
npm install
```

## Tests

```bash
npm test
```

The suite covers the recognizer, WAV parsing, history, hotkey parsing, daemon
config, and the terminal renderer's snapshot tests. It needs no model,
microphone, or GUI session.

## Build the app and DMG

```bash
npm run build
```

Outputs:

- `dist/Myna.app` — self-contained universal app
- `dist/Myna-1.1.0-universal.dmg` — drag-to-Applications disk image

The script:

1. compiles `native/menubar.swift` for `arm64` and `x86_64` with AppKit,
   ApplicationServices, Carbon, and CoreGraphics, then combines the slices with
   `lipo`
2. compiles the microphone helper the same way
3. copies a universal Node runtime into `Contents/Resources/runtime`
4. copies the daemon source and both `darwin` ONNX Runtime builds
5. writes `Info.plist`, the icon, and the licenses
6. ad-hoc signs every nested Mach-O file and the app bundle
7. creates the DMG, signs it ad-hoc, and verifies it

The model is **not** bundled. The app downloads it on first launch, exactly like
the release build.

If the local `/usr/local/bin/node` is not universal:

```bash
MYNA_NODE_BINARY=/path/to/universal/node npm run build
```

## Source map

| Path | Purpose |
| --- | --- |
| `native/menubar.swift` | Menu bar host, global hotkey, output mode, child process, icon |
| `native/recorder.swift` | Microphone helper, 16 kHz mono PCM |
| `src/daemon.js` | Recording state machine, clipboard, history |
| `src/asr.js` | ONNX sessions and greedy TDT decoder |
| `src/asr-service.js` | Recognizer process |
| `src/asr-client.js` | IPC handle for the recognizer |
| `src/recorder.js` | Microphone helper build/launch and custom recorder |
| `src/model.js` | Resumeable Hugging Face download |
| `src/app-config.js` | Turns `config.json` into the menu bar hotkey |
| `scripts/build-release.mjs` | Universal app and DMG builder |
| `test/` | Unit, snapshot, and FIFO integration tests |

The terminal renderer in `src/tui.js` is a development harness used by the
snapshot tests. It is not included in the app bundle and is not part of the
installed product.

## App bundle layout

```
Myna.app/Contents/
  Info.plist
  MacOS/Myna
  Resources/
    Myna.icns
    runtime/node
    app/
      package.json
      src/{daemon,asr,model,...}.js
      node_modules/{onnxruntime-node,onnxruntime-common}
    bin/myna-recorder
    licenses/
      MYNA-LICENSE
      NODE-LICENSE
      ONNXRUNTIME-LICENSE
      ONNXRUNTIME-THIRD-PARTY-NOTICES
```

`Myna.app/Contents/Resources/app/src` contains only the daemon's runtime files;
the TUI and build-time modules are not copied.

## Code signing and notarization

The current builder signs with `--sign -` (ad-hoc). That is enough for the app to
run locally, but Gatekeeper still requires **right-click → Open** on first launch.

For a one-click public release you need an Apple Developer ID and notarization:

1. Sign with a **Developer ID Application** identity instead of `-`.
2. Sign the nested binaries and the app with the hardened runtime.
3. Create the DMG.
4. Submit it:

```bash
xcrun notarytool submit dist/Myna-1.1.0-universal.dmg \
  --keychain-profile myna-notary --wait
xcrun stapler staple dist/Myna-1.1.0-universal.dmg
```

Keep the Developer ID private key and notary credentials out of the repository.

## Release checklist

- [ ] `npm test` passes
- [ ] `npm run build` produces the DMG
- [ ] `codesign --verify --deep --strict dist/Myna.app`
- [ ] `hdiutil verify dist/Myna-1.1.0-universal.dmg`
- [ ] launch `dist/Myna.app`, confirm the menu bar bird, model load, and a
      dictation in **Copy to clipboard** mode
- [ ] grant Accessibility, select **Type at cursor**, and confirm a dictation
      pastes into a text editor
- [ ] quit cleanly from the menu and confirm no daemon or recognizer processes
      remain
- [ ] attach the DMG and test the app from a copy in Applications
- [ ] publish the DMG and its SHA-256 in the GitHub release

## Licenses

Myna source: MIT. ONNX Runtime: MIT. Node.js: MIT and its bundled third-party
licenses. The Parakeet Redux model is CC-BY-4.0 and is not redistributed in the
app.
