#!/usr/bin/env python3
"""Drive the real TUI in a PTY without a model or microphone.

    python3 test/pty_demo.py              # space toggle, legacy keys
    python3 test/pty_demo.py --kitty      # hold Shift with kitty key events
    python3 test/pty_demo.py --kitty-space # Space toggle with kitty release events
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
KITTY = "--kitty" in sys.argv
KITTY_SPACE = "--kitty-space" in sys.argv
KITTY_MODE = KITTY or KITTY_SPACE

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
env = os.environ.copy()
env["TERM"] = "xterm-256color"
process = subprocess.Popen(
    [os.environ.get("NODE", "node"), os.path.join(ROOT, "bin/myna.js"), "--demo", "--no-copy", "--no-history"],
    cwd=ROOT,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)

raw = bytearray()
answered = False


def drain(seconds):
    global answered
    end = time.time() + seconds
    while time.time() < end:
        readable, _, _ = select.select([master], [], [], 0.03)
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        raw.extend(chunk)
        if KITTY_MODE and not answered and b"\x1b[?u" in chunk:
            answered = True
            # Claim support, then the app pushes flags 27.
            send(b"\x1b[?1u")


def send(data):
    try:
        os.write(master, data)
    except OSError:
        pass


SHIFT_DOWN = b"\x1b[57441;2:1u"
SHIFT_UP = b"\x1b[57441;1:3u"
SPACE_DOWN = b"\x1b[32;1:1;32u"
SPACE_UP = b"\x1b[32;1:3;32u"
released_space_stopped = None

if KITTY:
    # The query response arrives during the first drain.
    drain(0.9)
    send(SHIFT_DOWN)
    drain(0.7)
    send(SHIFT_UP)
    drain(2.0)
elif KITTY_SPACE:
    drain(0.9)
    send(SPACE_DOWN)
    drain(0.4)
    send(SPACE_UP)
    drain(1.3)
    released_space_stopped = "release notes" in ANSI.sub(b"", bytes(raw)).decode("utf-8", "replace")
    send(SPACE_DOWN)
    drain(2.0)
else:
    drain(1.0)
    send(b" ")
    drain(0.7)
    send(b" ")
    drain(2.0)

send(b"?")
drain(0.4)
send(b"?")
drain(0.2)
send(b"q")
drain(0.6)

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
    "Hold SHIFT",
    "Press SPACE",
    "RECORDING",
    "release SHIFT to transcribe",
    "TRANSCRIBING",
    "KEYS",
]
mode = "kitty shift" if KITTY else "kitty space" if KITTY_SPACE else "legacy space"
print("mode:", mode)
print("kitty query answered:", answered if KITTY_MODE else "n/a")
if released_space_stopped is not None:
    print("space release stopped the recording (must be False):", released_space_stopped)
print("exit:", code, "bytes:", len(raw))
for marker in markers:
    print(f"{marker!r}: {'yes' if marker in text else 'no'}")
