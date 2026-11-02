#!/usr/bin/env python3
"""Headless end-to-end test for `src/daemon.js`.

Uses a FIFO as the microphone, toggles via the daemon's JSON protocol, checks
the transcript, history, and clipboard. Does not involve the menu bar app.
"""

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAV = os.environ.get("MYNA_TEST_WAV", "/tmp/test.wav")
MODELS = os.path.expanduser("~/.myna/models")

if not os.path.exists(WAV):
    sys.exit(f"test clip missing: {WAV}")
if not os.path.isdir(MODELS):
    sys.exit("model missing; run myna once first")

with wave.open(WAV, "rb") as handle:
    clip = handle.readframes(handle.getnframes())

CHUNK = 3200  # 100 ms
home = tempfile.mkdtemp(prefix="myna-daemon-home-")
fifo_dir = tempfile.mkdtemp(prefix="myna-daemon-fifo-")
fifo = os.path.join(fifo_dir, "mic.fifo")
os.mkfifo(fifo)
os.symlink(MODELS, os.path.join(home, "models"))

clipboard_before = subprocess.run(["pbpaste"], capture_output=True).stdout
atexit.register(lambda: subprocess.run(["pbcopy"], input=clipboard_before, check=False))

process = subprocess.Popen(
    [
        os.environ.get("NODE", "node"),
        os.path.join(ROOT, "src/daemon.js"),
        "--home",
        home,
        "--recorder",
        f"cat {fifo}",
        "--warm",
        "1",
    ],
    cwd=ROOT,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

messages = []
lock = threading.Lock()


def reader():
    for line in process.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        with lock:
            messages.append(message)
        print("daemon:", message, flush=True)


def stderr_reader():
    for line in process.stderr:
        print("daemon stderr:", line.rstrip(), flush=True)


threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=stderr_reader, daemon=True).start()


def latest_status():
    with lock:
        for message in reversed(messages):
            if message.get("type") == "status":
                return message
    return {}


def last_result():
    with lock:
        for message in reversed(messages):
            if message.get("type") == "last":
                return message
    return None


def wait_for(predicate, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise TimeoutError(f"timed out waiting for {label}")


def send(message):
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


# ---------------------------------------------------------------- microphone

stop_writer = threading.Event()
clip_event = threading.Event()
clip_done = threading.Event()
writer_ready = threading.Event()


def writer():
    try:
        fd = os.open(fifo, os.O_WRONLY)
    except OSError as error:
        print("writer open failed:", error)
        return
    writer_ready.set()
    silence = b"\x00" * CHUNK
    position = 0
    try:
        while not stop_writer.is_set():
            if clip_event.is_set():
                while position < len(clip) and not stop_writer.is_set():
                    piece = clip[position : position + CHUNK]
                    position += len(piece)
                    os.write(fd, piece)
                    time.sleep(0.1)
                position = 0
                clip_event.clear()
                clip_done.set()
            else:
                os.write(fd, silence)
                time.sleep(0.1)
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


threading.Thread(target=writer, daemon=True).start()

try:
    idle = wait_for(
        lambda: latest_status().get("state") == "idle",
        90,
        "daemon idle (model load)",
    )
    print("idle status:", idle)

    send({"type": "toggle"})
    wait_for(lambda: latest_status().get("state") == "recording", 20, "recording")
    print("recording started; feeding clip")
    clip_event.set()
    clip_done.wait(timeout=15)
    time.sleep(0.5)
    send({"type": "toggle"})
    print("recording stopped")

    result = wait_for(last_result, 30, "transcript")
    print("transcript:", result.get("text"))
    print("clipboard:", subprocess.run(["pbpaste"], capture_output=True).stdout.decode()[-200:])
    print("history:", open(os.path.join(home, "history.json")).read()[-300:])

    cold = wait_for(
        lambda: latest_status().get("state") == "idle" and latest_status().get("mic") == "cold",
        8,
        "warm timer to release the microphone",
    )
    print("microphone released after the warm timer:", cold)

    send({"type": "shutdown"})
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    print("exit:", process.returncode)
finally:
    stop_writer.set()
    if process.poll() is None:
        process.kill()
    try:
        process.stdin.close()
    except Exception:
        pass
    shutil.rmtree(fifo_dir, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)
