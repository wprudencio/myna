/*
 * `myna daemon ...`
 *
 * start   build/launch the menu bar app, detached from the terminal
 * stop    ask the app to quit, then clean up
 * status  read the app's state file
 * toggle  send SIGUSR1 to the daemon (also handy as a second shortcut)
 */

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  daemonPaths,
  DEFAULT_CONFIG,
  isProcessAlive,
  normalizeConfig,
  readConfig,
  readState,
  recentLog,
  removeState,
  waitForState,
  writeConfig,
  writeMenubarConfig,
} from "./daemon-config.js";
import { parseHotkey } from "./hotkey.js";
import { ensureMenubarApp } from "./menubar.js";
import { resolveHome } from "./model.js";

const DAEMON_SCRIPT = fileURLToPath(new URL("./daemon.js", import.meta.url));

function usage() {
  return `myna daemon — background push-to-talk daemon

Usage
  myna daemon start [options]    start the daemon
                                  macOS: menu bar icon + global shortcut
                                  Linux: headless; bind a desktop shortcut
                                  to \`myna daemon toggle\`
  myna daemon stop               stop the daemon
  myna daemon status             show status
  myna daemon toggle             toggle recording (also a test hook)

Options for start
  --home <dir>        cache/config directory (default ~/.myna)
  --hotkey <keys>     default ctrl+alt+space (macOS shortcut label)
  --warm <seconds>    keep the microphone warm after a dictation (default 120;
                      0 = cold, -1 = always)
  --sounds            enable the start/finish sounds
  --no-sounds         disable sounds
  --recorder <cmd>    custom recorder, s16le 16 kHz mono on stdout
  --output <mode>     clipboard (default) or type — with type, the transcript
                      is typed at the cursor and the clipboard is untouched

macOS: the daemon lives in the menu bar; the terminal can be closed and the
shortcut works everywhere. Linux: the daemon is headless — bind your desktop
environment's shortcut (GNOME/KDE custom shortcuts, sway bindsym, Hyprland
bindl) to \`myna daemon toggle\`. Typing uses wtype (Wayland), xdotool (X11),
or ydotool; recording uses arecord, SoX, or ffmpeg.`;
}

function parseDaemonArgs(argv) {
  const options = {
    home: null,
    hotkey: null,
    sounds: null,
    warm: null,
    recorder: null,
    output: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--home") options.home = value();
    else if (arg.startsWith("--home=")) options.home = arg.slice(7);
    else if (arg === "--hotkey") options.hotkey = value();
    else if (arg.startsWith("--hotkey=")) options.hotkey = arg.slice(9);
    else if (arg === "--warm") {
      const raw = value();
      const warm = Number(raw);
      if (!Number.isInteger(warm) || warm < -1) throw new Error("--warm must be an integer >= -1");
      options.warm = warm;
    } else if (arg.startsWith("--warm=")) {
      const warm = Number(arg.slice(7));
      if (!Number.isInteger(warm) || warm < -1) throw new Error("--warm must be an integer >= -1");
      options.warm = warm;
    } else if (arg === "--sounds") options.sounds = true;
    else if (arg === "--no-sounds") options.sounds = false;
    else if (arg === "--recorder") options.recorder = value();
    else if (arg.startsWith("--recorder=")) options.recorder = arg.slice(11);
    else if (arg === "--output") options.output = value();
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.output !== null && options.output !== "clipboard" && options.output !== "type") {
    throw new Error("--output must be clipboard or type");
  }
  return options;
}

function formatUptime(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(startedAt || Date.now())) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function describeState(paths) {
  const state = await readState(paths);
  if (!state) {
    return { running: false, state: null };
  }
  const uiAlive = isProcessAlive(Number(state.appPid));
  const daemonAlive = isProcessAlive(Number(state.daemonPid));
  return { running: uiAlive, daemonAlive, state };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function cleanupStale(paths, state) {
  if (!state) return;
  if (!isProcessAlive(Number(state.appPid)) && isProcessAlive(Number(state.daemonPid))) {
    try {
      process.kill(Number(state.daemonPid), "SIGTERM");
    } catch {}
    await waitForExit(Number(state.daemonPid), 2000);
  }
  await removeState(paths);
}

async function start(options, paths) {
  const files = daemonPaths(paths);
  let config = await readConfig(paths).catch((error) => {
    throw new Error(`invalid ${files.config}: ${error.message}`);
  });
  if (options.hotkey) config.hotkey = parseHotkey(options.hotkey).normalized;
  if (options.sounds !== null) config.sounds = options.sounds;
  if (options.warm !== null) config.warmSeconds = options.warm;
  if (options.recorder !== null) config.recorder = options.recorder;
  if (options.output !== null) config.output = options.output;
  config = normalizeConfig(config);
  await writeConfig(paths, config);

  const parsed = parseHotkey(config.hotkey);
  const current = await describeState(paths);
  if (current.running) {
    console.log(`myna daemon is already running`);
    console.log(`  status    ${current.state.status ?? "unknown"}`);
    console.log(`  shortcut  ${parsed.label}`);
    if (config.output === "type") console.log(`  output    type at cursor`);
    if (options.hotkey || options.sounds !== null || options.warm !== null || options.output !== null) {
      console.log(`  note      stop and start to apply the new settings`);
    }
    return 0;
  }
  await cleanupStale(paths, current.state);

  if (process.platform === "darwin") return await startMenubar(paths, config, parsed, files);
  return await startHeadless(paths, config, parsed, files);
}

async function startMenubar(paths, config, parsed, files) {
  const bundle = await ensureMenubarApp({
    bundlePath: files.bundle,
    onStatus: (line) => process.stderr.write(`myna: ${line}\n`),
  });

  await writeMenubarConfig(paths, {
    node: process.execPath,
    daemon: DAEMON_SCRIPT,
    home: paths.root,
    hotkey: config.hotkey,
    sounds: config.sounds,
  });

  await fs.mkdir(paths.root, { recursive: true });
  const opened = spawnSync("/usr/bin/open", ["-a", bundle, "--args", "--config", files.menubar], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (opened.status !== 0) {
    throw new Error(
      `could not launch the menu bar app\n${(opened.stderr || opened.stdout || "").trim()}`
    );
  }

  const deadline = Date.now() + 20_000;
  let state = null;
  while (Date.now() < deadline) {
    state = await readState(paths);
    if (state && isProcessAlive(Number(state.appPid))) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!state || !isProcessAlive(Number(state.appPid))) {
    const log = await recentLog(paths, 8);
    throw new Error(
      `the menu bar app did not start${log ? `\n\n${log}` : ""}\nCheck that this is a local GUI session and that ${files.menubar} is valid.`
    );
  }

  console.log(`myna daemon running`);
  console.log(`  status    ${state.status ?? "starting"}`);
  console.log(`  shortcut  ${parsed.label}`);
  console.log(`  mic       ${state.mic ?? "cold"}`);
  console.log(`  menu bar  ${bundle}`);
  console.log(`  log       ${files.log}`);
  console.log(`\nThe terminal can be closed. The shortcut works while the menu bar icon is visible.`);
  return 0;
}

async function startHeadless(paths, config, parsed, files) {
  await fs.mkdir(paths.root, { recursive: true });

  /* Detached: the daemon owns its own session, logs to the daemon log, and
   * keeps running after the terminal closes. Its stdin is /dev/null — the
   * daemon skips the stdin control channel when it runs standalone. */
  let logFd = null;
  try {
    logFd = openSync(files.log, "a");
  } catch {}
  const child = spawn(process.execPath, [DAEMON_SCRIPT, "--home", paths.root], {
    detached: true,
    stdio: ["ignore", "ignore", logFd ?? "ignore"],
  });
  child.unref();
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {}
  }

  const state = await waitForState(
    paths,
    (candidate) => isProcessAlive(Number(candidate?.daemonPid)),
    15_000
  );
  if (!state) {
    const log = await recentLog(paths, 10);
    throw new Error(`the daemon did not start${log ? `\n\n${log}` : ""}`);
  }

  console.log(`myna daemon running (headless)`);
  console.log(`  status    ${state.status ?? "starting"}`);
  console.log(`  mic       ${state.mic ?? "cold"}`);
  console.log(`  log       ${files.log}`);
  if (config.output === "type") console.log(`  output    type at cursor (wtype/xdotool/ydotool)`);
  console.log(`\nBind your desktop shortcut (label: ${parsed.label}) to:`);
  console.log(`  myna daemon toggle`);
  console.log(`If myna is not on PATH, use the full path to the myna launcher.`);
  return 0;
}

async function stop(paths) {
  const current = await describeState(paths);
  if (!current.state) {
    console.log("myna daemon is not running");
    return 0;
  }
  const appPid = Number(current.state.appPid);
  const daemonPid = Number(current.state.daemonPid);
  if (isProcessAlive(appPid)) {
    try {
      process.kill(appPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (!(await waitForExit(appPid, 5000))) {
      try {
        process.kill(appPid, "SIGKILL");
      } catch {}
      await waitForExit(appPid, 1000);
    }
  }
  if (isProcessAlive(daemonPid)) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {}
    if (!(await waitForExit(daemonPid, 3000))) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {}
    }
  }
  await removeState(paths);
  console.log("myna daemon stopped");
  return 0;
}

async function status(paths) {
  const current = await describeState(paths);
  if (!current.state || (!current.running && !current.daemonAlive)) {
    console.log("myna daemon is not running");
    return 0;
  }
  const state = current.state;
  console.log(`myna daemon · ${current.running ? "running" : "daemon-only"}`);
  console.log(`  status    ${state.status ?? "unknown"}${state.message ? ` — ${state.message}` : ""}`);
  console.log(`  mic       ${state.mic ?? "cold"}`);
  console.log(`  shortcut  ${state.hotkey || parseHotkey(DEFAULT_CONFIG.hotkey).label}`);
  if (state.hotkeyError) console.log(`  shortcut! ${state.hotkeyError}`);
  console.log(`  since     ${formatUptime(state.startedAt)}`);
  if (state.appPid && state.appPid !== state.daemonPid) console.log(`  ui pid    ${state.appPid}`);
  if (state.daemonPid) console.log(`  daemon    ${state.daemonPid}`);
  if (!current.running && current.daemonAlive) {
    console.log("  note      the menu bar app is gone; stop will clean this up");
  }
  return 0;
}

async function toggle(paths) {
  const current = await describeState(paths);
  if (!current.state || !current.daemonAlive) {
    console.error("myna daemon is not running");
    return 1;
  }
  try {
    process.kill(Number(current.state.daemonPid), "SIGUSR1");
  } catch (error) {
    console.error(`could not toggle the daemon: ${error.message}`);
    return 1;
  }
  console.log("toggled");
  return 0;
}

export async function runDaemonCommand(argv) {
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log("myna daemon");
    return 0;
  }

  const command = argv[0];
  if (!["start", "stop", "status", "toggle"].includes(command)) {
    console.error(`myna daemon: unknown command “${command}”\n\n${usage()}`);
    return 2;
  }

  let commandOptions;
  try {
    commandOptions = parseDaemonArgs(argv.slice(1));
  } catch (error) {
    console.error(`myna daemon: ${error.message}`);
    return 2;
  }
  if (commandOptions.help) {
    console.log(usage());
    return 0;
  }

  const paths = resolveHome(commandOptions.home);
  try {
    if (command === "start") return await start(commandOptions, paths);
    if (command === "stop") return await stop(paths);
    if (command === "status") return await status(paths);
    if (command === "toggle") return await toggle(paths);
  } catch (error) {
    console.error(`myna daemon: ${error.message}`);
    return 1;
  }
  return 1;
}
