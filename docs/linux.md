# Linux

Myna runs headless on Linux: a background daemon owns the microphone and the
recognizer, and your desktop environment's shortcut triggers it. There is no
tray icon; `myna daemon status` answers questions instead.

## Requirements

- Linux with a desktop session — X11 or Wayland
- One recorder: `arecord` (alsa-utils), SoX, or ffmpeg
- For clipboard output: `wl-clipboard` (Wayland) or `xclip`/`xsel` (X11)
- For type-at-cursor output: `wtype` (Wayland), `xdotool` (X11), or `ydotool`
- A microphone, and permission to use it (PipeWire/PulseAudio or ALSA)

The speech model (about 363 MB) downloads on first start into
`~/.myna/models`. After that, Myna works offline.

## Install

Three ways, same recognizer underneath:

**Self-contained tarball** — bundles its own Node runtime, nothing else needed:

```bash
tar -xzf myna-<version>-linux-<arch>.tar.gz -C ~/.local
~/.local/myna/bin/myna daemon start
```

**AppImage** — from the same release page:

```bash
chmod +x Myna-<version>-linux-<arch>.AppImage
./Myna-<version>-linux-<arch>.AppImage        # starts the daemon
```

**From source** — needs Node 20.3+:

```bash
git clone https://github.com/wprudencio/myna
cd myna && npm install
node bin/myna.js daemon start
```

## Bind the shortcut

After `myna daemon start`, bind a custom shortcut to `myna daemon toggle`
(use the full path if myna is not on `PATH`):

- **GNOME**: Settings → Keyboard → View and Customize Shortcuts → Custom
  Shortcuts → **+**. Command: `myna daemon toggle`.
- **KDE**: System Settings → Shortcuts → Add New → Command or Script.
- **sway** (`~/.config/sway/config`):

  ```
  bindsym $mod+space exec myna daemon toggle
  ```

- **Hyprland** (`~/.config/hypr/hyprland.conf`):

  ```
  bind = SUPER, space, exec, myna daemon toggle
  ```

Press once to start recording; press again to stop and transcribe.

> [!IMPORTANT]
> The daemon must run **inside your graphical session** — it needs the
> microphone, the clipboard, and the keyboard tools. Start it from a terminal
> in the session (and add it to your session's autostart), or use the systemd
> user service below.

## Output modes

- `--output clipboard` (default) — the transcript is copied; paste it
  yourself.
- `--output type` — the transcript is typed at your cursor with
  `wtype`/`xdotool`/`ydotool` and **the clipboard is never touched**.

For `ydotool`, run `ydotoold` first (most distros ship a systemd unit), and
make sure your user can write to `/dev/uinput` (usually the `input` group).
On Wayland, prefer `wtype`; on X11, prefer `xdotool`.

## Start at login

A systemd user service keeps the daemon in your session:

```ini
# ~/.config/systemd/user/myna.service
[Unit]
Description=Myna dictation daemon
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=%h/.local/myna/bin/node %h/.local/myna/app/src/daemon.js --home %h/.myna
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now myna.service
```

Then bind the shortcut to:

```bash
systemctl --user kill --signal=SIGUSR1 myna.service
```

## Commands

```text
myna daemon start [--output clipboard|type] [--warm <seconds>] [--recorder <cmd>]
myna daemon toggle     toggle recording (bind this to a shortcut)
myna daemon status     show state, microphone, uptime
myna daemon stop       stop the daemon
myna <audio-file>      transcribe a file and print the text
myna                   interactive terminal view (Space toggles)
```

## Troubleshooting

- **No audio recorder found** — install `alsa-utils` (arecord), SoX, or
  ffmpeg. Check `arecord -l` sees your microphone. PipeWire users usually
  get ffmpeg's `pulse` backend for free.
- **Nothing is typed** — check the tool matches your session: `wtype` on
  Wayland, `xdotool` on X11, `ydotool` anywhere with `ydotoold` running.
  The daemon log is `~/.myna/daemon.log`.
- **Toggle does nothing** — `myna daemon status` first. If the state file is
  stale (`~/.myna/daemon.json` names a dead PID), `myna daemon stop` cleans
  it up.
- **Clipboard fails over SSH** — there is no desktop clipboard; Myna's OSC 52
  fallback only works from the interactive terminal view.

## Packaging notes for maintainers

- Tarballs are built by `scripts/build-linux.mjs` on any OS.
- AppImages are built by `scripts/build-appimage.sh` on Linux (CI does it via
  `.github/workflows/appimage.yml`).
- The npm package installs `myna` through `bin/myna.js` and needs Node 20.3+.
