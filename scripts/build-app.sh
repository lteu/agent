#!/usr/bin/env bash
#
# 组装 Ai.app（内置 Node 运行时 + 应用代码）到指定路径。
# 被 make-dmg.sh / make-pkg.sh 共用。
#
# 用法:  bash scripts/build-app.sh <输出 .app 路径>
# 环境:  ARCH=arm64|x64|universal（默认 arm64）  NODE_VERSION=v24.16.0
#
set -euo pipefail

OUT_APP="${1:?用法: build-app.sh <输出 .app 路径>}"
NODE_VERSION="${NODE_VERSION:-v24.16.0}"
ARCH="${ARCH:-arm64}"
APP_NAME="Ai"
BUNDLE_ID="com.ailab.ai-cli"

# 目标架构清单：universal = 同时内置 arm64 + x64，启动时按机器自动选
case "$ARCH" in
  universal) ARCH_LIST=(arm64 x64) ;;
  arm64|x64) ARCH_LIST=("$ARCH") ;;
  *) echo "ARCH 只能是 arm64 / x64 / universal"; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
DIST="$ROOT/dist"
CACHE="$DIST/.node-cache"
STAGE="$DIST/_stage"
APP="$OUT_APP"

echo "▶ 构建 dist/cli.js"
npm run build >/dev/null

echo "▶ 安装运行时依赖（--omit=dev）"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$ROOT/package.json" "$STAGE/"
( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent )

echo "▶ 取得官方（可移植的）Node 二进制：${ARCH_LIST[*]}"
for A in "${ARCH_LIST[@]}"; do
  PKG="node-$NODE_VERSION-darwin-$A"
  if [[ ! -x "$CACHE/$PKG/bin/node" ]]; then
    mkdir -p "$CACHE"
    echo "  下载 Node $NODE_VERSION ($A) ..."
    curl -fL --retry 3 -o "$CACHE/$PKG.tar.gz" \
      "https://nodejs.org/dist/$NODE_VERSION/$PKG.tar.gz"
    tar -xzf "$CACHE/$PKG.tar.gz" -C "$CACHE"
  fi
done

echo "▶ 组装 $APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# 应用负载：入口 + package.json + 运行时依赖
cp "$DIST/cli.js"           "$APP/Contents/Resources/app/cli.js"
cp "$ROOT/package.json"     "$APP/Contents/Resources/app/package.json"
cp -R "$STAGE/node_modules" "$APP/Contents/Resources/app/node_modules"

# 内置 node：每个架构存成 node-<arch>，启动器按机器自动挑
for A in "${ARCH_LIST[@]}"; do
  cp "$CACHE/node-$NODE_VERSION-darwin-$A/bin/node" "$APP/Contents/Resources/node-$A"
  chmod +x "$APP/Contents/Resources/node-$A"
done

# 启动器：双击 .app → 打开 Terminal 跑对话（.app 自身没有 TTY，必须借 Terminal）
cat > "$APP/Contents/MacOS/$APP_NAME" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
# 按当前机器架构选内置 node；缺失则退回到唯一存在的那个
M="$(uname -m)"; [ "$M" = "x86_64" ] && M="x64"
NODE="$RES/node-$M"
[ -x "$NODE" ] || NODE="$(ls "$RES"/node-* 2>/dev/null | head -1)"
ENTRY="$RES/app/cli.js"
# 在新的 Terminal 窗口里运行；单引号包路径以容纳空格
CMD="clear; '$NODE' '$ENTRY'; status=\$?; echo; echo '— ai 已退出（按任意键关闭窗口）—'; read -n 1 -s; exit \$status"
/usr/bin/osascript <<OSA
tell application "Terminal"
  activate
  do script "$CMD"
end tell
OSA
LAUNCH
chmod +x "$APP/Contents/MacOS/$APP_NAME"

# Info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>ai</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

# 即时（ad-hoc）签名，缓解 Gatekeeper
echo "▶ ad-hoc 代码签名"
for N in "$APP"/Contents/Resources/node-*; do
  codesign --force --sign - "$N" 2>/dev/null || true
done
codesign --force --deep --sign - "$APP" 2>/dev/null || true

rm -rf "$STAGE"
echo "✅ app 完成: $APP"
