#!/usr/bin/env python3
"""Start the real TUI (cached model) and inspect the boot → idle path.

The microphone permission for this test environment is denied, so this also
checks the permission banner. It does not record.
"""

import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
env = os.environ.copy()
env["TERM"] = "xterm-256color"
process = subprocess.Popen(
    [os.environ.get("NODE", "node"), os.path.join(ROOT, "bin/myna.js"), "--no-history"],
    cwd=ROOT,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)

raw = bytearray()
deadline = time.time() + 45
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw.extend(chunk)
    text = ANSI.sub(b"", bytes(raw)).decode("utf-8", "replace")
    if "Hold SHIFT" in text or "Press SPACE" in text:
        break

# Keep reading the PTY while waiting. A TUI that is not drained can block on
# its own output, which is a test artifact rather than an app bug.
deadline = time.time() + 3
while time.time() < deadline and process.poll() is None:
    readable, _, _ = select.select([master], [], [], 0.05)
    if readable:
        try:
            raw.extend(os.read(master, 65536))
        except OSError:
            break
try:
    os.write(master, b"q")
except OSError:
    pass
deadline = time.time() + 8
while time.time() < deadline and process.poll() is None:
    readable, _, _ = select.select([master], [], [], 0.05)
    if readable:
        try:
            raw.extend(os.read(master, 65536))
        except OSError:
            break
try:
    code = process.wait(timeout=3)
except subprocess.TimeoutExpired:
    process.kill()
    code = "timeout"
try:
    os.close(master)
except OSError:
    pass

text = ANSI.sub(b"", bytes(raw)).decode("utf-8", "replace")
markers = [
    "SETTING UP",
    "STARTING",
    "loading the recognizer",
    "microphone access is off",
    "Press SPACE",
    "Hold SHIFT",
    "mic off",
]
print("exit:", code, "bytes:", len(raw))
for marker in markers:
    print(f"{marker!r}: {'yes' if marker in text else 'no'}")
print("\n--- last screen-ish lines ---")
lines = [line.rstrip() for line in text.replace("\r", "").split("\n") if line.strip()]
for line in lines[-30:]:
    print(line)
