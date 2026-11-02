#!/usr/bin/env python3
"""Full end-to-end TUI test using a FIFO as the microphone.

Feeds a real 16 kHz mono WAV through --recorder, holds Space for the clip,
waits for the transcript, and checks the clipboard. This is the closest we
can get to a real dictation without microphone permission.
"""

import fcntl
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAV = os.environ.get("MYNA_TEST_WAV", "/tmp/test.wav")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

if not os.path.exists(WAV):
    sys.exit(
        f"test clip missing: {WAV}\n"
        "Generate one with:\n"
        '  say -o /tmp/test.aiff "Hello, this is a test of the myna speech recognizer."\n'
        "  afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/test.aiff /tmp/test.wav"
    )

models = os.path.expanduser("~/.myna/models")
if not os.path.isdir(models):
    sys.exit("the model is not cached yet; run myna once, then retry this test")

fifo_dir = tempfile.mkdtemp(prefix="myna-fifo-")
test_home = tempfile.mkdtemp(prefix="myna-e2e-home-")
os.symlink(models, os.path.join(test_home, "models"))
fifo = os.path.join(fifo_dir, "mic.fifo")
os.mkfifo(fifo)
clipboard_before = subprocess.run(["pbpaste"], capture_output=True).stdout
atexit = __import__("atexit")
atexit.register(lambda: subprocess.run(["pbcopy"], input=clipboard_before, check=False))

with wave.open(WAV, "rb") as handle:
    assert handle.getframerate() == 16000
    assert handle.getnchannels() == 1
    assert handle.getsampwidth() == 2
    clip = handle.readframes(handle.getnframes())

CHUNK = 3200  # 100 ms
samples_per_chunk = CHUNK // 2

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
env = os.environ.copy()
env["TERM"] = "xterm-256color"
process = subprocess.Popen(
    [
        os.environ.get("NODE", "node"),
        os.path.join(ROOT, "bin/myna.js"),
        "--recorder",
        f"cat {fifo}",
        "--home",
        test_home,
        "--debug",
    ],
    cwd=ROOT,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)

raw = bytearray()
stop = threading.Event()
clip_event = threading.Event()
clip_done = threading.Event()
writer_ready = threading.Event()
written = 0
clip_started_at = [0.0]
clip_finished_at = [0.0]


def writer():
    global written
    try:
        fd = os.open(fifo, os.O_WRONLY)
    except OSError:
        return
    writer_ready.set()
    silence = b"\x00" * CHUNK
    position = 0
    try:
        while not stop.is_set():
            if clip_event.is_set():
                clip_started_at[0] = time.time()
                while position < len(clip) and not stop.is_set():
                    piece = clip[position : position + CHUNK]
                    position += len(piece)
                    os.write(fd, piece)
                    written += len(piece)
                    time.sleep(0.1)
                position = 0
                clip_event.clear()
                clip_finished_at[0] = time.time()
                clip_done.set()
            else:
                os.write(fd, silence)
                written += len(silence)
                time.sleep(0.1)
    except OSError as error:
        print("writer error:", error)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


thread = threading.Thread(target=writer, daemon=True)
thread.start()


def drain(seconds):
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


def text():
    return ANSI.sub(b"", bytes(raw)).decode("utf-8", "replace")


def wait_for(needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain(0.2)
        if needle in text():
            return True
    return False


def send(data):
    try:
        os.write(master, data)
        return True
    except OSError:
        return False


def wait_event(event, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if event.is_set():
            return True
        drain(0.1)
    return event.is_set()


print("writer ready:", wait_event(writer_ready, 15, "writer"))
print("welcome:", wait_for("Press SPACE", 60), "after", round(time.time(), 1))
mic_lines = [
    line.strip()
    for line in text().replace("\r", "").split("\n")
    if "microphone" in line.lower() or "custom" in line.lower()
]
if mic_lines:
    print("mic line:", mic_lines[-1])

# Hold Space, feed the phrase, hold through the trailing silence.
send(b" ")
drain(0.2)
clip_event.set()
wait_event(clip_done, 15, "clip")
drain(0.4)
print(
    "writer alive before stop:",
    thread.is_alive(),
    "written:",
    written,
    "clip sec:",
    round(clip_finished_at[0] - clip_started_at[0], 2),
    "clip bytes:",
    len(clip),
)
send(b" ")
print("recording stopped")

transcribed = wait_for("speech recognizer", 25)
# Give the clipboard a moment after the text appears.
time.sleep(1.0)
drain(0.3)
print("transcript marker:", transcribed)
print("copied marker:", "copied" in text())
print("transcribing marker:", "TRANSCRIBING" in text())

cliptext = subprocess.run(["pbpaste"], capture_output=True).stdout.decode("utf-8", "replace")

send(b"q")
time.sleep(0.6)
try:
    code = process.wait(timeout=5)
except subprocess.TimeoutExpired:
    process.kill()
    code = "timeout"
stop.set()
thread.join(timeout=2)
try:
    os.close(master)
except OSError:
    pass
shutil.rmtree(fifo_dir, ignore_errors=True)

print("exit:", code)
print("clipboard:", repr(cliptext[-300:]))
try:
    with open(os.path.join(test_home, "history.json")) as handle:
        history = handle.read()
    print("history saved:", "speech recognizer" in history)
except OSError:
    print("history saved: False")
lines = [line.rstrip() for line in text().replace("\r", "").split("\n") if line.strip()]
print("\n--- transcript-looking lines ---")
for line in lines:
    if "speech" in line.lower() or "clipboard" in line.lower():
        print(line)
print("\n--- recording lines ---")
for line in lines:
    if "RECORDING" in line or "too short" in line or "transcrib" in line.lower():
        print(line)

print("\n--- debug log tail ---")
try:
    with open(os.path.join(test_home, "debug.log")) as handle:
        for line in handle.read().splitlines()[-25:]:
            print(line)
except OSError:
    pass
shutil.rmtree(test_home, ignore_errors=True)

try:
    subprocess.run(["pbcopy"], input=clipboard_before, check=False)
except Exception:
    pass
