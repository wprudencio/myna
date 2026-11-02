# Using Myna

Myna lives in the menu bar. There is no main window and no Dock icon.

## Dictate

1. Put the cursor where you want the text.
2. Press **⌃⌥Space** (Control–Option–Space).
3. Speak normally.
4. Press **⌃⌥Space** again.

When you stop, Myna transcribes locally, copies the text to the clipboard, and
flashes the bird green. Paste with **⌘V**.

Myna does **not** paste for you. This keeps it from needing Accessibility
permission and from typing into the wrong window.

You can also start and stop from the menu with **Start Recording** / **Stop
Recording**. The menu item is useful if the shortcut conflicts with another app.

A single recording is limited to **5 minutes**. Myna stops automatically at the
limit and transcribes what it has.

## Menu bar states

| Bird | Meaning |
| --- | --- |
| Outline bird | Idle, ready |
| Bird with a timer | Recording |
| Animated coral crest | Transcribing |
| Green flash | Copied to the clipboard |
| Orange bird / warning | Needs attention; open the menu for the reason |
| Grey or hidden | The app is starting, or a menu bar manager is hiding it |

During recording the menu bar also shows a timer.

## The menu

- **Start / Stop Recording** — the same as the shortcut
- **Copy Last Transcript** — put the latest transcript back on the clipboard
- The latest transcript preview
- **Microphone: cold / warm** and **Release Microphone**
- **Sounds** — the start and finish sounds
- **Open Microphone Settings…**
- **Restart Daemon** if the background process stopped
- **Shortcut: ⌃⌥Space** — the current shortcut
- **Quit Myna**

## Microphone warm mode

Myna starts with the microphone **cold**. After a dictation it keeps the input
open for **two minutes**, so the next recording starts instantly. The orange
microphone indicator in the menu bar stays visible while it is warm.

Choose **Release Microphone** to close it immediately. The warm time is
configurable in [Configuration](configuration.md).

## Clipboard and history

The transcript is copied automatically. Myna keeps the **last 100 transcripts**
in `~/.myna/history.json`; the menu shows the most recent one and can copy it
again.

Myna does not read the clipboard. It only writes the transcript to it.

## Language

Parakeet Redux understands **25 European languages**, including Portuguese,
English, Spanish, French, German, Italian, Dutch, Polish, and Swedish. There is
no language switch; speak naturally.

## Start at login (optional)

Myna deliberately does not install a login item by itself.

1. Open **System Settings → General → Login Items**.
2. Add **Myna** from Applications.

Myna starts in the menu bar and reads the same configuration.

## Sounds

The start and finish sounds are on by default. Turn them off from the menu. The
choice is remembered per user.

## Multiple displays and Spaces

The menu bar item follows the active display. The global shortcut works in every
app, Space, and full-screen window.

## Quitting

Choose **Quit Myna** in the menu. The background recognizer and microphone are
stopped with it.
