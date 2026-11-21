#!/usr/bin/env node
/*
 * Build self-contained Linux tarballs: one per architecture (x64, arm64),
 * each carrying a bundled Node runtime, the Myna source, the Linux ONNX
 * Runtime natives, and a `myna` launcher. The model downloads on first
 * start, exactly like the macOS app.
 *
 * Runs on any OS — it only copies files and downloads the official Node
 * linux binary from nodejs.org. AppImages are built separately on Linux
 * (or CI) with scripts/build-appimage.sh.
 *
 * Usage:
 *   node scripts/build-linux.mjs [--arch x64|arm64] [--node-version v22.14.0]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

const TARGETS = [
  { name: "x64", label: "Linux (x64)" },
  { name: "arm64", label: "Linux (arm64)" },
];

const pkg = JSON.parse(await fs.readFile(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

function parse(argv) {
  const options = { arch: null, nodeVersion: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arch" && i + 1 < argv.length) options.arch = argv[++i];
    else if (arg.startsWith("--arch=")) options.arch = arg.slice(7);
    else if (arg === "--node-version" && i + 1 < argv.length) options.nodeVersion = argv[++i];
    else if (arg.startsWith("--node-version=")) options.nodeVersion = arg.slice(15);
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.arch && !["x64", "arm64"].includes(options.arch)) {
    throw new Error("--arch must be x64 or arm64");
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} exited with ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

async function resolveNodeVersion(requested) {
  const version = requested || process.env.MYNA_NODE_VERSION;
  if (version) return version.startsWith("v") ? version : `v${version}`;
  const response = await fetch("https://nodejs.org/dist/index.json");
  if (!response.ok) throw new Error(`could not read the Node index: ${response.status}`);
  const index = await response.json();
  const lts = index.find((entry) => entry.lts);
  if (!lts) throw new Error("could not resolve the current Node LTS from nodejs.org");
  console.log(`Node LTS: ${lts.version} (${lts.lts})`);
  return lts.version;
}

async function downloadNode(version, arch, work) {
  const file = join(work, `node-${version}-linux-${arch}.tar.xz`);
  const url = `https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz`;
  if (!existsSync(file)) {
    console.log(`downloading ${basename(file)}`);
    run("curl", ["-fL", "--retry", "3", "--progress-bar", "-o", file, url]);
  }
  const extract = join(work, `node-${version}-linux-${arch}`);
  rmSync(extract, { recursive: true, force: true });
  await fs.mkdir(extract, { recursive: true });
  run("tar", ["-xJf", file, "-C", extract, "--strip-components=1"]);
  return join(extract, "bin", "node");
}

const LAUNCHER = `#!/bin/sh
# Myna launcher — put this directory on your PATH, or call it by full path.
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/bin/node" "$root/app/bin/myna.js" "$@"
`;

function linuxReadme(target) {
  return `# Myna ${VERSION} — Linux (${target.name})

Local dictation: press your shortcut, speak, press it again. The transcript
lands on the clipboard — or is typed at your cursor.

## Quick start

    ./bin/myna daemon start --output type        # or clipboard (default)

Then bind your desktop environment's custom shortcut to:

    <this directory>/bin/myna daemon toggle

## Runtime dependencies

Pick the pieces you need:

- Recording: arecord (alsa-utils), SoX, or ffmpeg
- Clipboard: wl-clipboard (Wayland), xclip or xsel (X11)
- Type at cursor: wtype (Wayland), xdotool (X11), or ydotool

The speech model (about 363 MB) downloads on first start into ~/.myna/models
and Myna works offline after that. Nothing else touches the network.

Desktop-environment shortcut examples (GNOME, KDE, sway, Hyprland) and a
systemd user service are in docs/linux.md in the source repository.
`;
}

async function stageApp(target, nodeBinary) {
  const stage = join(DIST, ".build-linux", `linux-${target.name}`);
  rmSync(stage, { recursive: true, force: true });
  const app = join(stage, "myna");

  await fs.mkdir(join(app, "bin"), { recursive: true });
  await fs.mkdir(join(app, "app", "bin"), { recursive: true });
  await fs.mkdir(join(app, "app", "src"), { recursive: true });
  await fs.mkdir(join(app, "licenses"), { recursive: true });

  console.log(`staging the ${target.name} app`);
  await fs.copyFile(nodeBinary, join(app, "bin", "node"));
  await fs.chmod(join(app, "bin", "node"), 0o755);

  await fs.writeFile(join(app, "bin", "myna"), LAUNCHER);
  await fs.chmod(join(app, "bin", "myna"), 0o755);

  await fs.writeFile(
    join(app, "app", "package.json"),
    `${JSON.stringify({ name: "myna-runtime", version: VERSION, private: true, type: "module" }, null, 2)}\n`
  );
  await fs.copyFile(join(ROOT, "bin", "myna.js"), join(app, "app", "bin", "myna.js"));

  /* Every src file: the TUI is usable on Linux too, and the daemon needs the
   * lot. menubar.js is carried along; it exits early on non-darwin. */
  for (const file of await fs.readdir(join(ROOT, "src"))) {
    if (!file.endsWith(".js")) continue;
    await fs.copyFile(join(ROOT, "src", file), join(app, "app", "src", file));
  }

  const ort = join(app, "app", "node_modules", "onnxruntime-node");
  const common = join(app, "app", "node_modules", "onnxruntime-common");
  await fs.mkdir(join(ort, "bin", "napi-v6", "linux", target.name), { recursive: true });
  await fs.copyFile(join(ROOT, "node_modules/onnxruntime-node/package.json"), join(ort, "package.json"));
  await fs.cp(join(ROOT, "node_modules/onnxruntime-node/dist"), join(ort, "dist"), { recursive: true });
  await fs.cp(
    join(ROOT, `node_modules/onnxruntime-node/bin/napi-v6/linux/${target.name}`),
    join(ort, "bin", "napi-v6", "linux", target.name),
    { recursive: true }
  );
  await fs.mkdir(common, { recursive: true });
  await fs.copyFile(join(ROOT, "node_modules/onnxruntime-common/package.json"), join(common, "package.json"));
  await fs.cp(join(ROOT, "node_modules/onnxruntime-common/dist"), join(common, "dist"), {
    recursive: true,
  });

  await fs.cp(join(ROOT, "assets", "licenses"), join(app, "licenses"), { recursive: true });
  await fs.copyFile(join(ROOT, "LICENSE"), join(app, "licenses", "MYNA-LICENSE"));
  await fs.writeFile(join(app, "README.md"), linuxReadme(target));

  return { stage, app };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const targets = options.arch ? TARGETS.filter((target) => target.name === options.arch) : TARGETS;

  await fs.mkdir(DIST, { recursive: true });
  const work = join(DIST, ".build-linux", "download");
  await fs.mkdir(work, { recursive: true });

  const nodeVersion = await resolveNodeVersion(options.nodeVersion);
  for (const target of targets) {
    console.log(`\n=== ${target.label} ===`);
    const nodeBinary = await downloadNode(nodeVersion, target.name, work);
    const { stage } = await stageApp(target, nodeBinary);

    const tar = join(DIST, `myna-${VERSION}-linux-${target.name}.tar.gz`);
    await fs.rm(tar, { force: true });
    console.log(`creating the ${target.name} tarball`);
    run("tar", ["-czf", tar, "-C", stage, "myna"]);

    const hash = createHash("sha256").update(await fs.readFile(tar)).digest("hex");
    await fs.writeFile(`${tar}.sha256`, `${hash}  ${basename(tar)}\n`);
    const size = (await fs.stat(tar)).size;
    console.log(`  tar:    ${basename(tar)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`  sha256: ${hash}`);
  }
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`);
  process.exitCode = 1;
});
