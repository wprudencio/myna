/*
 * Refresh the menu bar app's shortcut from the user's config.json.
 *
 * The Swift host asks the bundled Node runtime to run this before it registers
 * the global hotkey. It keeps the shortcut parser in one place, so the app and
 * the development CLI understand the same strings.
 */

import { DEFAULT_CONFIG, daemonPaths, readConfig, writeJsonAtomic } from "./daemon-config.js";
import { parseHotkey } from "./hotkey.js";
import { resolveHome } from "./model.js";

function homeFromArgs(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--home" && index + 1 < argv.length) return argv[index + 1];
    if (argv[index].startsWith("--home=")) return argv[index].slice(7);
  }
  return null;
}

const paths = resolveHome(homeFromArgs(process.argv.slice(2)));
let config = { ...DEFAULT_CONFIG };
try {
  config = await readConfig(paths);
} catch (error) {
  process.stderr.write(`myna app: ignoring invalid config: ${error.message}\n`);
}

const hotkey = parseHotkey(config.hotkey);
const menubar = {
  home: paths.root,
  keyCode: hotkey.keyCode,
  modifiers: hotkey.modifiers,
  hotkey: hotkey.normalized,
  hotkeyLabel: hotkey.label,
  sounds: config.sounds,
};

await writeJsonAtomic(daemonPaths(paths).menubar, menubar);
process.stdout.write(`${JSON.stringify(menubar)}\n`);
