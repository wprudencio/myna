# Development

Myna is a native Swift menu bar host around a small Node daemon and an ONNX
recognizer. The release DMGs are built on macOS and contain no developer tools.

## Requirements

- macOS 13.5 or newer
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js 20.3 or newer
- A **universal** Node binary for packaging (`x86_64` + `arm64`); the build
  slices it into the two DMGs

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

For UI work, launching the built app with `--shortcut` opens the shortcut picker
directly:

```bash
# Intel Mac
dist/Myna-x64.app/Contents/MacOS/Myna --shortcut
# Apple Silicon
dist/Myna-arm64.app/Contents/MacOS/Myna --shortcut
```

## Build the apps and DMGs

```bash
npm run build
```

Outputs:

- `dist/Myna-arm64.app` — self-contained Apple Silicon app
- `dist/Myna-x64.app` — self-contained Intel app
- `dist/Myna-1.2.1-arm64.dmg` — Apple Silicon disk image
- `dist/Myna-1.2.1-x64.dmg` — Intel disk image
- `dist/Myna-1.2.1-*.dmg.sha256` — checksums

The script:

1. compiles `native/menubar.swift` for `arm64` and `x86_64` with AppKit,
   ApplicationServices, Carbon, and CoreGraphics
2. compiles the microphone helper the same way
3. slices the universal Node runtime with `lipo -thin` into each app
4. copies the daemon source and only the matching `darwin` ONNX Runtime build
5. writes `Info.plist`, the icon, and the licenses
6. ad-hoc signs every nested Mach-O file and each app bundle
7. creates both DMGs with LZMA compression, signs them ad-hoc, verifies them,
   and writes the SHA-256 files

The model is **not** bundled. The app downloads it on first launch, exactly like
the release build.

If the local `/usr/local/bin/node` is not universal:

```bash
MYNA_NODE_BINARY=/path/to/universal/node npm run build
```

## Source map

| Path | Purpose |
| --- | --- |
| `native/menubar.swift` | Menu bar host, shortcut picker, output mode, child process, icon |
| `native/recorder.swift` | Microphone helper, 16 kHz mono PCM |
| `src/daemon.js` | Recording state machine, clipboard, history |
| `src/asr.js` | ONNX sessions and greedy TDT decoder |
| `src/asr-service.js` | Recognizer process |
| `src/asr-client.js` | IPC handle for the recognizer |
| `src/recorder.js` | Microphone helper build/launch and custom recorder |
| `src/model.js` | Resumeable Hugging Face download |
| `src/app-config.js` | Turns `config.json` into the menu bar hotkey |
| `scripts/build-release.mjs` | Two-architecture app and DMG builder |
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
for arch in arm64 x64; do
  xcrun notarytool submit "dist/Myna-1.2.1-$arch.dmg" \
    --keychain-profile myna-notary --wait
  xcrun stapler staple "dist/Myna-1.2.1-$arch.dmg"
done
```

Keep the Developer ID private key and notary credentials out of the repository.

## Release checklist

- [ ] `npm test` passes
- [ ] `npm run build` produces both DMGs and both SHA-256 files
- [ ] `codesign --verify --deep --strict dist/Myna-arm64.app dist/Myna-x64.app`
- [ ] `hdiutil verify dist/Myna-1.2.1-arm64.dmg dist/Myna-1.2.1-x64.dmg`
- [ ] launch the app for this Mac, confirm the menu bar bird, model load, and a
      dictation in **Copy to clipboard** mode
- [ ] grant Accessibility, select **Type at cursor**, and confirm a dictation
      pastes into a text editor
- [ ] open **Shortcut…**, record a new combination, save it, and confirm it
      works immediately without restarting
- [ ] quit cleanly from the menu and confirm no daemon or recognizer processes
      remain
- [ ] attach both DMGs, confirm each contains a thin app for its architecture,
      and test the native build from Applications
- [ ] publish both DMGs and their SHA-256 files in the GitHub release

## Licenses

Myna source: MIT. ONNX Runtime: MIT. Node.js: MIT and its bundled third-party
licenses. The Parakeet Redux model is CC-BY-4.0 and is not redistributed in the
app.
