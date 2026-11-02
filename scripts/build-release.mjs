#!/usr/bin/env node
/*
 * Build the self-contained macOS apps and two drag-to-Applications DMGs:
 * one for Apple Silicon (arm64) and one for Intel (x64).
 *
 * Usage:
 *   node scripts/build-release.mjs
 *
 * Each app bundles its own Node runtime and ONNX Runtime slice for one
 * architecture, the Swift menu bar host, and the Swift microphone helper.
 * The model is downloaded on first launch and is not part of the app.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { infoPlist } from "../src/menubar.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const MIN_MACOS = "13.5";

const TARGETS = [
  {
    name: "arm64",
    swiftArch: "arm64",
    nodeArch: "arm64",
    ortArch: "arm64",
    label: "Apple Silicon (arm64)",
  },
  {
    name: "x64",
    swiftArch: "x86_64",
    nodeArch: "x64",
    ortArch: "x64",
    label: "Intel (x64)",
  },
];

const pkg = JSON.parse(await fs.readFile(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

function appPath(target) {
  return join(DIST, `Myna-${target.name}.app`);
}

function dmgPath(target) {
  return join(DIST, `Myna-${VERSION}-${target.name}.dmg`);
}

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
        "The two-DMG build slices a universal Node binary into arm64 and x64. " +
        "Use the official universal macOS Node build or set MYNA_NODE_BINARY."
    );
  }
  return { binary, info: info.trim() };
}

async function compile({ source, output, arch, frameworks = [] }) {
  await fs.mkdir(join(output, ".."), { recursive: true });
  const args = [
    "-O",
    "-swift-version",
    "5",
    "-target",
    `${arch}-apple-macosx${MIN_MACOS}`,
  ];
  for (const framework of frameworks) args.push("-framework", framework);
  args.push("-o", output, source);
  console.log(`  swiftc ${arch} ${relative(ROOT, source)}`);
  run("swiftc", args);
  await fs.chmod(output, 0o755);
}

async function copyRuntime(target, nodeBinary) {
  const app = appPath(target);
  const resources = join(app, "Contents", "Resources");
  const appRuntime = join(resources, "app");

  await fs.mkdir(join(resources, "runtime"), { recursive: true });
  await fs.mkdir(join(resources, "bin"), { recursive: true });
  await fs.mkdir(join(resources, "licenses"), { recursive: true });

  console.log(`slicing the ${target.name} Node runtime`);
  const nodeOutput = join(resources, "runtime", "node");
  run("lipo", ["-thin", target.swiftArch, nodeBinary, "-output", nodeOutput]);
  await fs.chmod(nodeOutput, 0o755);

  console.log("copying the application source");
  await fs.mkdir(join(appRuntime, "src"), { recursive: true });
  await fs.writeFile(
    join(appRuntime, "package.json"),
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
    await fs.copyFile(join(ROOT, "src", file), join(appRuntime, "src", file));
  }

  console.log(`copying ONNX Runtime for darwin ${target.ortArch}`);
  const ort = join(appRuntime, "node_modules", "onnxruntime-node");
  const common = join(appRuntime, "node_modules", "onnxruntime-common");
  await fs.mkdir(ort, { recursive: true });
  await fs.copyFile(join(ROOT, "node_modules/onnxruntime-node/package.json"), join(ort, "package.json"));
  await fs.cp(join(ROOT, "node_modules/onnxruntime-node/dist"), join(ort, "dist"), {
    recursive: true,
  });
  await fs.cp(
    join(ROOT, "node_modules/onnxruntime-node/bin/napi-v6/darwin", target.ortArch),
    join(ort, "bin/napi-v6/darwin", target.ortArch),
    { recursive: true }
  );
  await fs.mkdir(common, { recursive: true });
  await fs.copyFile(join(ROOT, "node_modules/onnxruntime-common/package.json"), join(common, "package.json"));
  await fs.cp(join(ROOT, "node_modules/onnxruntime-common/dist"), join(common, "dist"), {
    recursive: true,
  });

  await fs.copyFile(join(ROOT, "assets", "Myna.icns"), join(resources, "Myna.icns"));
  await fs.cp(join(ROOT, "assets", "licenses"), join(resources, "licenses"), { recursive: true });
  await fs.copyFile(join(ROOT, "LICENSE"), join(resources, "licenses", "MYNA-LICENSE"));
}

function sign(path, extra = []) {
  run("codesign", ["--force", "--sign", "-", ...extra, path]);
}

async function signApp(target) {
  const app = appPath(target);
  const resources = join(app, "Contents", "Resources");
  const appRuntime = join(resources, "app");
  const ort = join(
    appRuntime,
    "node_modules/onnxruntime-node/bin/napi-v6/darwin",
    target.ortArch
  );

  console.log(`signing nested binaries (ad-hoc, ${target.name})`);
  const targets = [
    join(resources, "runtime", "node"),
    join(resources, "bin", "myna-recorder"),
    join(ort, "onnxruntime_binding.node"),
    join(ort, "libonnxruntime.1.23.2.dylib"),
    join(app, "Contents", "MacOS", "Myna"),
  ];
  for (const path of targets) {
    /* Node ships with hardened-runtime flags and JIT entitlements. Preserve
     * them so the bundled runtime keeps working after ad-hoc signing. */
    const extra = path.endsWith("/runtime/node")
      ? ["--preserve-metadata=entitlements,flags"]
      : [];
    sign(path, extra);
  }
  sign(app, ["--identifier", "com.wprudencio.myna"]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
}

async function writePlist(app) {
  const path = join(app, "Contents", "Info.plist");
  await fs.writeFile(path, infoPlist());
  run("plutil", ["-lint", path]);
  run("plutil", ["-p", path]);
}

async function buildApp(target, nodeBinary) {
  const app = appPath(target);
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");

  await fs.rm(app, { recursive: true, force: true });
  await fs.mkdir(join(contents, "MacOS"), { recursive: true });
  await fs.mkdir(resources, { recursive: true });

  console.log(`compiling the menu bar app (${target.name})`);
  await compile({
    source: join(ROOT, "native/menubar.swift"),
    output: join(contents, "MacOS", "Myna"),
    arch: target.swiftArch,
    frameworks: ["AppKit", "ApplicationServices", "Carbon", "CoreGraphics"],
  });

  console.log(`compiling the microphone helper (${target.name})`);
  await compile({
    source: join(ROOT, "native/recorder.swift"),
    output: join(resources, "bin", "myna-recorder"),
    arch: target.swiftArch,
  });

  await copyRuntime(target, nodeBinary);
  await writePlist(app);
  await signApp(target);

  console.log(`lipo: ${run("lipo", ["-info", join(contents, "MacOS", "Myna")]).trim()}`);
  console.log(`lipo: ${run("lipo", ["-info", join(resources, "bin", "myna-recorder")]).trim()}`);
  console.log(`lipo: ${run("lipo", ["-info", join(resources, "runtime", "node")]).trim()}`);
}

async function buildDmg(target) {
  const app = appPath(target);
  const work = join(DIST, `.dmg-root-${target.name}`);
  const dmg = dmgPath(target);
  const platform = target.name === "arm64" ? "Apple Silicon" : "Intel";
  const other = target.name === "arm64" ? "an Intel Mac" : "an Apple Silicon Mac";

  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  await fs.cp(app, join(work, "Myna.app"), { recursive: true, verbatimSymlinks: true });
  await fs.symlink("/Applications", join(work, "Applications"));
  await fs.writeFile(
    join(work, "READ ME FIRST.txt"),
    `Myna ${VERSION} — ${platform} (${target.name})

This is the ${platform} build. If this Mac is ${other}, download the other
DMG from the release page.

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

  await fs.rm(dmg, { force: true });
  console.log(`creating the ${target.name} DMG`);
  run("hdiutil", [
    "create",
    "-volname",
    "Myna",
    "-srcfolder",
    work,
    "-ov",
    "-format",
    "ULMO",
    "-fs",
    "HFS+",
    dmg,
  ]);
  sign(dmg);
  run("hdiutil", ["verify", dmg]);
  await fs.rm(work, { recursive: true, force: true });
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
  await fs.rm(join(DIST, ".build"), { recursive: true, force: true });
  await fs.rm(join(DIST, "Myna.app"), { recursive: true, force: true });

  const artifacts = [];
  for (const target of TARGETS) {
    console.log(`\n=== ${target.label} ===`);
    await buildApp(target, node.binary);
    await buildDmg(target);
    artifacts.push(target);
  }

  console.log("\nArtifacts:");
  for (const target of artifacts) {
    const dmg = dmgPath(target);
    const size = (await fs.stat(dmg)).size;
    const hash = createHash("sha256").update(await fs.readFile(dmg)).digest("hex");
    await fs.writeFile(`${dmg}.sha256`, `${hash}  ${basename(dmg)}\n`);
    console.log(`  app: ${relative(ROOT, appPath(target))}`);
    console.log(`  dmg: ${relative(ROOT, dmg)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`  sha256: ${hash}`);
  }

  const native = process.arch === "arm64" ? "arm64" : "x64";
  console.log(`\nTest build for this Mac: ${relative(ROOT, appPath({ name: native }))}`);
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`);
  process.exitCode = 1;
});
