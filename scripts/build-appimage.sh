#!/usr/bin/env bash
#
# Build the Myna AppImage for the current architecture. Run on Linux (or in
# CI); appimagetool is downloaded automatically. Requires tar, curl, node,
# and xz-utils. The self-contained tarball from scripts/build-linux.mjs is
# built first if it is missing.
#
set -euo pipefail

VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "build-appimage: unsupported architecture $ARCH" >&2; exit 1 ;;
esac

TARBALL="dist/myna-${VERSION}-linux-${ARCH}.tar.gz"
[ -f "$TARBALL" ] || node scripts/build-linux.mjs --arch "$ARCH"

WORK="dist/.build-linux/appimage-${ARCH}"
rm -rf "$WORK"
mkdir -p "$WORK/AppDir/usr/bin" "$WORK/AppDir/usr/share/icons/hicolor/256x256/apps"

tar -xzf "$TARBALL" -C "$WORK/AppDir/usr"
ln -s ../myna/bin/myna "$WORK/AppDir/usr/bin/myna"

cp assets/myna-icon.png "$WORK/AppDir/myna.png"
cp assets/myna-icon.png "$WORK/AppDir/.DirIcon"
cp assets/myna-icon.png "$WORK/AppDir/usr/share/icons/hicolor/256x256/apps/myna.png"

cat > "$WORK/AppDir/myna.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Myna
GenericName=Dictation
Comment=Local dictation: press your shortcut, speak, and the transcript lands on your clipboard or at your cursor
Exec=myna daemon start
Icon=myna
Terminal=false
Categories=Utility;AudioVideo;
Keywords=dictation;speech;voice;asr;clipboard;offline;
EOF

cat > "$WORK/AppDir/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/myna" "$@"
EOF
chmod +x "$WORK/AppDir/AppRun"

echo "downloading appimagetool"
curl -fL --retry 3 --progress-bar -o "$WORK/appimagetool" \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$(uname -m).AppImage"
chmod +x "$WORK/appimagetool"

OUT="dist/Myna-${VERSION}-linux-${ARCH}.AppImage"
echo "packing $OUT"
APPIMAGE_EXTRACT_AND_RUN=1 "$WORK/appimagetool" "$WORK/AppDir" "$OUT"
sha256sum "$OUT" | awk -v f="Myna-${VERSION}-linux-${ARCH}.AppImage" '{print $1"  "f}' > "$OUT.sha256"
echo "built $OUT"
