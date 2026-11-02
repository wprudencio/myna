#!/usr/bin/env node
/*
 * Build the self-contained universal macOS app and a drag-to-Applications DMG.
 *
 * Usage:
 *   node scripts/build-release.mjs
 *
 * The app bundles its own universal Node runtime, both macOS ONNX Runtime
 * architectures, the Swift menu bar host, and the Swift microphone helper.
 * The model is downloaded on first launch and is not part of the app.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { infoPlist } from "../src/menubar.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const BUILD = join(DIST, ".build");
const APP = join(DIST, "Myna.app");
const CONTENTS = join(APP, "Contents");
const RESOURCES = join(CONTENTS, "Resources");
const APP_RUNTIME = join(RESOURCES, "app");
const WORK = join(DIST, "dmg-root");

const pkg = JSON.parse(await fs.readFile(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const DMG = join(DIST, `Myna-${VERSION}-universal.dmg`);
const MIN_MACOS = "13.5";
const ARCHS = ["arm64", "x86_64"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(`${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} exited with ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

function commandExists(command) {
  const result = spawnSync("/usr/bin/which", [command], { encoding: "utf8" });
  return result.status === 0;
}

function resolveNodeBinary() {
  const candidates = [
    process.env.MYNA_NODE_BINARY,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    process.execPath,
  ].filter(Boolean);
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) throw new Error("could not find a Node binary; set MYNA_NODE_BINARY");

  const info = run("lipo", ["-info", binary]);
  const universal = info.includes("x86_64") && info.includes("arm64");
  if (!universal) {
    throw new Error(
      `the Node binary is not universal: ${binary}\n${info.trim()}\n` +
        "Use the official universal macOS Node build or set MYNA_NODE_BINARY."
    );
  }
  return { binary, info: info.trim() };
}

async function compileUniversal({ source, output, frameworks = [] }) {
  const pieces = [];
  for (const arch of ARCHS) {
    const piece = join(BUILD, `${relative(BUILD, output).replaceAll("/", "-")}.${arch}`);
    const args = [
      "-O",
      "-swift-version",
      "5",
      "-target",
      `${arch}-apple-macosx${MIN_MACOS}`,
    ];
    for (const framework of frameworks) args.push("-framework", framework);
    args.push("-o", piece, source);
    console.log(`  swiftc ${arch} ${relative(ROOT, source)}`);
    run("swiftc", args);
    pieces.push(piece);
  }
  await fs.mkdir(join(output, ".."), { recursive: true });
  run("lipo", ["-create", "-output", output, ...pieces]);
  await fs.chmod(output, 0o755);
  for (const piece of pieces) await fs.rm(piece, { force: true });
}

async function copyRuntime(nodeBinary) {
  await fs.mkdir(join(RESOURCES, "runtime"), { recursive: true });
  await fs.mkdir(join(RESOURCES, "bin"), { recursive: true });
  await fs.mkdir(join(RESOURCES, "licenses"), { recursive: true });

  console.log("copying the universal Node runtime");
  await fs.copyFile(nodeBinary, join(RESOURCES, "runtime", "node"));
  await fs.chmod(join(RESOURCES, "runtime", "node"), 0o755);

  console.log("copying the application source");
  await fs.mkdir(join(APP_RUNTIME, "src"), { recursive: true });
  await fs.writeFile(
    join(APP_RUNTIME, "package.json"),
    `${JSON.stringify(
      { name: "myna-runtime", version: VERSION, private: true, type: "module" },
      null,
      2
    )}\n`
  );
  const runtimeFiles = [
    "app-config.js",
    "asr-client.js",
    "asr-service.js",
    "asr.js",
    "clipboard.js",
    "daemon-config.js",
    "daemon.js",
    "history.js",
    "hotkey.js",
    "model.js",
    "recorder.js",
    "util.js",
  ];
  for (const file of runtimeFiles) {
    await fs.copyFile(join(ROOT, "src", file), join(APP_RUNTIME, "src", file));
  }

  console.log("copying ONNX Runtime for darwin x64 and arm64");
  const ort = join(APP_RUNTIME, "node_modules", "onnxruntime-node");
  const common = join(APP_RUNTIME, "node_modules", "onnxruntime-common");
  await fs.mkdir(ort, { recursive: true });
  await fs.copyFile(join(ROOT, "node_modules/onnxruntime-node/package.json"), join(ort, "package.json"));
  await fs.cp(join(ROOT, "node_modules/onnxruntime-node/dist"), join(ort, "dist"), {
    recursive: true,
  });
  for (const arch of ["x64", "arm64"]) {
    await fs.cp(
      join(ROOT, "node_modules/onnxruntime-node/bin/napi-v6/darwin", arch),
      join(ort, "bin/napi-v6/darwin", arch),
      { recursive: true }
    );
  }
  await fs.mkdir(common, { recursive: true });
  await fs.copyFile(join(ROOT, "node_modules/onnxruntime-common/package.json"), join(common, "package.json"));
  await fs.cp(join(ROOT, "node_modules/onnxruntime-common/dist"), join(common, "dist"), {
    recursive: true,
  });

  await fs.copyFile(join(ROOT, "assets", "Myna.icns"), join(RESOURCES, "Myna.icns"));
  await fs.cp(join(ROOT, "assets", "licenses"), join(RESOURCES, "licenses"), { recursive: true });
  await fs.copyFile(join(ROOT, "LICENSE"), join(RESOURCES, "licenses", "MYNA-LICENSE"));
}

function sign(path, extra = []) {
  run("codesign", ["--force", "--sign", "-", ...extra, path]);
}

async function signApp() {
  console.log("signing nested binaries (ad-hoc)");
  const targets = [
    join(RESOURCES, "runtime", "node"),
    join(RESOURCES, "bin", "myna-recorder"),
    join(RESOURCES, "app", "node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node"),
    join(RESOURCES, "app", "node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/libonnxruntime.1.23.2.dylib"),
    join(RESOURCES, "app", "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node"),
    join(RESOURCES, "app", "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.23.2.dylib"),
    join(CONTENTS, "MacOS", "Myna"),
  ];
  for (const target of targets) {
    /* Node ships with hardened-runtime flags and JIT entitlements. Preserve
     * them so the bundled runtime keeps working after ad-hoc signing. */
    const extra = target.endsWith("/runtime/node")
      ? ["--preserve-metadata=entitlements,flags"]
      : [];
    sign(target, extra);
  }
  sign(APP, ["--identifier", "com.wprudencio.myna"]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);
}

async function writePlist() {
  const path = join(CONTENTS, "Info.plist");
  await fs.writeFile(path, infoPlist());
  run("plutil", ["-lint", path]);
  run("plutil", ["-p", path]);
}

async function buildApp(nodeBinary) {
  await fs.rm(APP, { recursive: true, force: true });
  await fs.rm(BUILD, { recursive: true, force: true });
  await fs.mkdir(join(CONTENTS, "MacOS"), { recursive: true });
  await fs.mkdir(BUILD, { recursive: true });

  console.log("compiling the menu bar app (universal)");
  await compileUniversal({
    source: join(ROOT, "native/menubar.swift"),
    output: join(CONTENTS, "MacOS", "Myna"),
    frameworks: ["AppKit", "ApplicationServices", "Carbon", "CoreGraphics"],
  });

  console.log("compiling the microphone helper (universal)");
  await compileUniversal({
    source: join(ROOT, "native/recorder.swift"),
    output: join(RESOURCES, "bin", "myna-recorder"),
  });

  await copyRuntime(nodeBinary);
  await writePlist();
  await signApp();

  console.log(`lipo: ${run("lipo", ["-info", join(CONTENTS, "MacOS", "Myna")]).trim()}`);
  console.log(`lipo: ${run("lipo", ["-info", join(RESOURCES, "bin", "myna-recorder")]).trim()}`);
  console.log(`lipo: ${run("lipo", ["-info", join(RESOURCES, "runtime", "node")]).trim()}`);
}

async function buildDmg() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.cp(APP, join(WORK, "Myna.app"), { recursive: true, verbatimSymlinks: true });
  await fs.symlink("/Applications", join(WORK, "Applications"));
  await fs.writeFile(
    join(WORK, "READ ME FIRST.txt"),
    `Myna ${VERSION} — universal (Intel and Apple Silicon)

1. Drag Myna into Applications.
2. Open Myna from Applications.
3. The menu bar bird appears. The first launch downloads the speech model
   (about 363 MB) in the background.
4. Press Control-Option-Space to start dictating. Press it again to stop.

Myna lives in the menu bar. There is no Dock icon and no terminal setup.

If macOS says "Myna cannot be opened because the developer cannot be
verified", right-click Myna in Applications, choose Open, and confirm once.
This build is signed locally, not notarized by Apple.

Microphone permission is requested by Myna the first time you dictate.
You can change it later in System Settings > Privacy & Security > Microphone.

Everything runs on this Mac. Audio and transcripts never leave the machine.
The only network request is the first-run model download.
`
  );

  await fs.rm(DMG, { force: true });
  console.log("creating the DMG");
  run("hdiutil", [
    "create",
    "-volname",
    "Myna",
    "-srcfolder",
    WORK,
    "-ov",
    "-format",
    "UDZO",
    "-fs",
    "HFS+",
    DMG,
  ]);
  sign(DMG);
  run("hdiutil", ["verify", DMG]);
  await fs.rm(WORK, { recursive: true, force: true });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Myna is a macOS app; build it on macOS");
  for (const tool of ["swiftc", "lipo", "codesign", "hdiutil", "plutil"]) {
    if (!commandExists(tool)) throw new Error(`${tool} is required`);
  }

  const node = resolveNodeBinary();
  console.log(`Node: ${node.binary}\n${node.info}`);
  console.log(`Version: ${VERSION}`);

  await fs.mkdir(DIST, { recursive: true });
  await buildApp(node.binary);
  await buildDmg();

  const size = (await fs.stat(DMG)).size;
  const hash = createHash("sha256").update(await fs.readFile(DMG)).digest("hex");
  console.log("");
  console.log(`app: ${relative(ROOT, APP)}`);
  console.log(`dmg: ${relative(ROOT, DMG)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`sha256: ${hash}`);
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`);
  process.exitCode = 1;
});
