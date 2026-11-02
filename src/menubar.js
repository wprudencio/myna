/*
 * Build the menu bar app bundle in the user's cache.
 *
 * A plain executable would work for the status item, but a .app bundle gives
 * macOS a stable identity for the microphone permission prompt and for the
 * menu bar item. It is built locally with swiftc, ad-hoc signed, and cached.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./args.js";

const SOURCE = fileURLToPath(new URL("../native/menubar.swift", import.meta.url));
const ICON_SOURCE = fileURLToPath(new URL("../assets/Myna.icns", import.meta.url));
const BUNDLE_ID = "com.wprudencio.myna";

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>Myna</string>
  <key>CFBundleDisplayName</key>
  <string>Myna</string>
  <key>CFBundleExecutable</key>
  <string>Myna</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>Myna</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Myna transcribes your speech locally when you use the dictation shortcut.</string>
</dict>
</plist>
`;
}

export async function ensureMenubarApp({ bundlePath, onStatus }) {
  if (process.platform !== "darwin") {
    throw new Error("the menu bar daemon is macOS-only");
  }

  const compiler = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (compiler.error || compiler.status !== 0) {
    throw new Error("swiftc is not available; install the Xcode command line tools");
  }

  const source = await fs.readFile(SOURCE, "utf8");
  const icon = await fs.readFile(ICON_SOURCE);
  const hash = createHash("sha1").update(compiler.stdout).update(source).update(icon).digest("hex");
  const binary = join(bundlePath, "Contents", "MacOS", "Myna");
  const hashFile = join(bundlePath, "Contents", "Resources", "source.sha1");

  try {
    const stored = (await fs.readFile(hashFile, "utf8")).trim();
    await fs.access(binary);
    if (stored === hash) return bundlePath;
  } catch {}

  onStatus?.("building the menu bar app (one time)…");
  await fs.rm(bundlePath, { recursive: true, force: true });
  await fs.mkdir(join(bundlePath, "Contents", "MacOS"), { recursive: true });
  await fs.mkdir(join(bundlePath, "Contents", "Resources"), { recursive: true });
  await fs.writeFile(join(bundlePath, "Contents", "Info.plist"), infoPlist());
  await fs.copyFile(ICON_SOURCE, join(bundlePath, "Contents", "Resources", "Myna.icns"));
  await fs.writeFile(hashFile, `${hash}\n`);

  const temp = `${binary}.${process.pid}.tmp`;
  const result = spawnSync(
    "swiftc",
    [
      "-O",
      "-swift-version",
      "5",
      "-framework",
      "AppKit",
      "-framework",
      "Carbon",
      "-o",
      temp,
      SOURCE,
    ],
    { encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 }
  );

  if (result.error || result.status !== 0) {
    await fs.rm(temp, { force: true }).catch(() => {});
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`could not build the menu bar app\n${detail.split("\n").slice(-12).join("\n")}`);
  }

  await fs.chmod(temp, 0o755);
  await fs.rename(temp, binary);

  const signed = spawnSync("codesign", ["--force", "--sign", "-", bundlePath], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (signed.status !== 0) {
    /* Ad-hoc signing is nice for a stable TCC identity, but an unsigned local
     * build still launches. Keep the warning in the daemon log only. */
    onStatus?.(`codesign warning: ${(signed.stderr || "").trim()}`);
  }

  onStatus?.("menu bar app ready");
  return bundlePath;
}

export { BUNDLE_ID };
