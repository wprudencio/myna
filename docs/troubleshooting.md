# Troubleshooting

## The app will not open

**“Myna” cannot be opened because the developer cannot be verified.**

This build is signed locally, not notarized. Right-click **Myna** in Applications,
choose **Open**, and confirm once. After that, normal double-clicking works.

**“Myna” is damaged and can’t be opened.**

Delete the app, download the DMG again, and repeat the install. If it still
happens, remove the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Myna.app
```

**“Myna is already running.”**

Only one copy can run. Look in the menu bar. If the icon is hidden by a menu bar
manager, quit Myna and open it again, or use Activity Monitor to quit any leftover
**Myna** process.

## There is no bird in the menu bar

- Check that Myna is running in **Activity Monitor**.
- A menu bar manager (Bartender, Ice, Hidden Bar) may be hiding the item. Allow
  Myna or temporarily quit the manager.
- The menu bar may be full. Remove another item or use a menu bar manager.
- Quit and reopen Myna.

## The shortcut does nothing

- Another app may own **⌃⌥Space**. Quit that app or choose another shortcut in
  [Configuration](configuration.md), then reopen Myna.
- If the menu says **Shortcut unavailable**, the system refused the registration.
  Pick a different combination.
- The menu's **Start Recording** item always works, even if the shortcut does not.

## macOS did not ask for the microphone

The prompt appears on the first dictation, not on launch. If it never appeared,
open the Myna menu and choose **Open Microphone Settings…**. Make sure **Myna** is
enabled in **System Settings → Privacy & Security → Microphone**.

The microphone used is the current default input. Check
**System Settings → Sound → Input** and make sure the device is not muted.

## Type at cursor does nothing

Check that **After dictation → Type at cursor** is selected and that **Myna** is
enabled in **System Settings → Privacy & Security → Accessibility**.

The menu has **After dictation → Open Accessibility Settings…** for this. If Myna
was already enabled there but a new build still cannot paste, remove Myna from the
list with the **−** button, add `/Applications/Myna.app` again, and reopen Myna.

Even without permission, the transcript is copied. Paste it with **⌘V**.

Note that **Type at cursor** sends **⌘V**, so it works in apps that support the
standard paste shortcut. Secure input fields may ignore synthetic keystrokes.

## Nothing is transcribed

- Speak after pressing the shortcut; the menu bar should show a timer.
- Check the input device and its level in **System Settings → Sound → Input**.
- Parakeet Redux is trained on 25 European languages. Speech in other languages
  may be unreliable.
- Very quiet or very noisy audio can produce an empty result.
- Open the menu; if it shows an error, see the log below.

## The first download is slow or stuck

The model is about **363 MB** and is fetched in resumable chunks. A slow
connection can take several minutes.

1. Quit Myna.
2. Reopen it. The download resumes from the completed chunks.
3. If it repeatedly fails, check `~/.myna/daemon.log`.
4. As a last resort, quit Myna, remove `~/.myna/models`, and reopen to start
   cleanly.

The app needs a working connection to `huggingface.co` for this one download.
After it finishes, dictation works offline.

## The app uses too much CPU or memory

The first load warms the recognizer and can use a CPU core for a few seconds.
During transcription the encoder is CPU-heavy by design. The model uses roughly
350 MB of memory while loaded.

If the Mac is busy, transcription takes longer. Closing other memory-heavy apps
helps. Quit Myna when you do not need it.

## The mic stays warm

This is intentional. Myna keeps the microphone open for two minutes after a
dictation so the next one starts instantly. Choose **Release Microphone** in the
menu, or set `warmSeconds` to `0` in [Configuration](configuration.md).

## A transcription was cut off

A single recording is limited to **5 minutes**. Start a new recording for the
next part. Long pauses and silence at the start are trimmed automatically.

## Where is the log?

`~/.myna/daemon.log` contains the background process output. It is the first
place to look for model, microphone, and crash details.

You can open the folder from Finder with **Go → Go to Folder…** and entering
`~/.myna`.

## Reset Myna

Quit Myna, then remove the cache:

```bash
rm -rf ~/.myna
```

Reopen Myna. It downloads the model again and starts with default settings. Your
macOS microphone permission remains until you reset it in System Settings.

## Uninstall

See [Install](install.md#uninstalling).
