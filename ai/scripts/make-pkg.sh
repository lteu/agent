#!/usr/bin/env bash
#
# 打包成 macOS 安装包 .pkg —— 双击即走「安装向导」：
#   • 把 Ai.app 装到 /Applications
#   • postinstall 以 root 把 `ai` 命令写到 /usr/local/bin（各机型默认都在 PATH）
# 装完新开终端直接 `ai` 可用，无需任何额外步骤。
#
# 用法:  npm run pkg                 (ARCH=arm64|x64|universal)
# 产物:  dist/ai-<version>-<arch>.pkg
#
set -euo pipefail

ARCH="${ARCH:-arm64}"
APP_NAME="Ai"
BUNDLE_ID="com.ailab.ai-cli"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
DIST="$ROOT/dist"
WORK="$DIST/_pkgbuild"
APP="$WORK/$APP_NAME.app"
PKGROOT="$WORK/root"          # 负载树：/Applications/Ai.app
SCRIPTS="$WORK/scripts"       # 安装脚本（postinstall）
PKG="$DIST/ai-$VERSION-$ARCH.pkg"

echo "▶ 打包 PKG  ai $VERSION ($ARCH)"
rm -rf "$WORK"
mkdir -p "$PKGROOT/Applications" "$SCRIPTS"

# 1) 组装 .app（共用脚本）
bash "$HERE/build-app.sh" "$APP"

# 2) 放进负载树
cp -R "$APP" "$PKGROOT/Applications/"

# 3) postinstall：装好后把 ai 命令写到 /usr/local/bin（脚本以 root 运行）
cat > "$SCRIPTS/postinstall" <<'POST'
#!/bin/bash
set -e
APP="/Applications/Ai.app"
mkdir -p /usr/local/bin
cat > /usr/local/bin/ai <<EOF
#!/bin/bash
RES="$APP/Contents/Resources"
M="\$(uname -m)"; [ "\$M" = "x86_64" ] && M="x64"
NODE="\$RES/node-\$M"; [ -x "\$NODE" ] || NODE="\$(ls "\$RES"/node-* | head -1)"
exec "\$NODE" "\$RES/app/cli.js" "\$@"
EOF
chmod 755 /usr/local/bin/ai
exit 0
POST
chmod +x "$SCRIPTS/postinstall"

# 4) 生成 pkg（component pkg 即可双击安装）
echo "▶ pkgbuild"
pkgbuild \
  --root "$PKGROOT" \
  --scripts "$SCRIPTS" \
  --identifier "$BUNDLE_ID" \
  --version "$VERSION" \
  --install-location "/" \
  "$PKG" >/dev/null

rm -rf "$WORK"

echo ""
echo "✅ 完成: $PKG"
ls -lh "$PKG" | awk '{print "   大小:", $5}'
echo "   双击安装 → 新开终端输入 ai 即可（首次右键→打开以绕过未签名提示）。"
