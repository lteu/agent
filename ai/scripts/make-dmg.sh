#!/usr/bin/env bash
#
# 打包成可分发的 macOS .dmg：内置 Node 运行时 + 应用代码。
# 收到的人无需安装任何东西，双击 Ai.app 即在终端进入对话；缺 key 会引导输入。
#
# 用法:  npm run dmg          (= bash scripts/make-dmg.sh)
# 产物:  dist/ai-<version>.dmg
#
set -euo pipefail

# ——— 可调参数 ———
NODE_VERSION="${NODE_VERSION:-v24.16.0}"   # 内置的 Node LTS
ARCH="${ARCH:-arm64}"                       # arm64 | x64 | universal（两者通吃）
APP_NAME="Ai"                               # .app 显示名
BUNDLE_ID="com.ailab.ai-cli"

# 目标架构清单：universal = 同时内置 arm64 + x64，启动时按机器自动选
case "$ARCH" in
  universal) ARCH_LIST=(arm64 x64) ;;
  arm64|x64) ARCH_LIST=("$ARCH") ;;
  *) echo "ARCH 只能是 arm64 / x64 / universal"; exit 1 ;;
esac

# ——— 路径 ———
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
DIST="$ROOT/dist"
WORK="$DIST/_pkg"                 # 临时装配目录
APP="$WORK/$APP_NAME.app"
DMG_ROOT="$DIST/_dmgroot"
DMG="$DIST/ai-$VERSION-$ARCH.dmg" # 架构进文件名，避免互相覆盖
VOLNAME="ai $VERSION"
CACHE="$DIST/.node-cache"

echo "▶ 打包 ai $VERSION  (node $NODE_VERSION / ${ARCH_LIST[*]})"

# ——— 1. 构建应用代码 ———
echo "▶ 构建 dist/cli.js"
npm run build >/dev/null

# ——— 2. 准备只含运行时依赖的 node_modules ———
echo "▶ 安装运行时依赖（--omit=dev）"
STAGE="$WORK/stage"
rm -rf "$WORK" "$DMG_ROOT"
mkdir -p "$STAGE"
cp "$ROOT/package.json" "$STAGE/"
( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent )

# ——— 3. 取得官方（可移植的）Node 二进制 ———
NODE_PKG="node-$NODE_VERSION-darwin-$ARCH"
NODE_TGZ="$CACHE/$NODE_PKG.tar.gz"
NODE_BIN="$CACHE/$NODE_PKG/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
  mkdir -p "$CACHE"
  echo "▶ 下载 Node $NODE_VERSION ..."
  curl -fL --retry 3 -o "$NODE_TGZ" \
    "https://nodejs.org/dist/$NODE_VERSION/$NODE_PKG.tar.gz"
  tar -xzf "$NODE_TGZ" -C "$CACHE"
fi

# ——— 4. 组装 .app ———
echo "▶ 组装 $APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# 应用负载：入口 + package.json + 运行时依赖
cp "$DIST/cli.js"           "$APP/Contents/Resources/app/cli.js"
cp "$ROOT/package.json"     "$APP/Contents/Resources/app/package.json"
cp -R "$STAGE/node_modules" "$APP/Contents/Resources/app/node_modules"

# 内置 node
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"

# 启动器：双击 .app → 打开 Terminal 跑对话（.app 自身没有 TTY，必须借 Terminal）
cat > "$APP/Contents/MacOS/$APP_NAME" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
NODE="$RES/node"
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

# ——— 5. 即时（ad-hoc）签名，缓解 Gatekeeper ———
echo "▶ ad-hoc 代码签名"
codesign --force --sign - "$APP/Contents/Resources/node" 2>/dev/null || true
codesign --force --deep --sign - "$APP" 2>/dev/null || true

# ——— 6. 组 DMG 内容 ———
echo "▶ 组装 DMG 内容"
mkdir -p "$DMG_ROOT"
cp -R "$APP" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"

# 可选：把 ai 装成终端命令的小脚本
cat > "$DMG_ROOT/安装命令行 ai.command" <<'INSTALL'
#!/bin/bash
# 把 Applications 里的 Ai.app 暴露成终端命令 `ai`
set -e
APP="/Applications/Ai.app"
[ -d "$APP" ] || { echo "请先把 Ai.app 拖到「应用程序」里再运行本脚本"; exit 1; }
TARGET="/usr/local/bin"; mkdir -p "$TARGET" 2>/dev/null || TARGET="$HOME/.local/bin"; mkdir -p "$TARGET"
cat > "$TARGET/ai" <<EOF
#!/bin/bash
exec "$APP/Contents/Resources/node" "$APP/Contents/Resources/app/cli.js" "\$@"
EOF
chmod +x "$TARGET/ai"
echo "✅ 已安装到 $TARGET/ai"
case ":$PATH:" in *":$TARGET:"*) :;; *) echo "提示：把 $TARGET 加到 PATH： echo 'export PATH=\"$TARGET:\$PATH\"' >> ~/.zshrc";; esac
echo "现在新开终端输入 ai 即可。按任意键关闭"; read -n 1 -s
INSTALL
chmod +x "$DMG_ROOT/安装命令行 ai.command"

# README
cat > "$DMG_ROOT/使用说明.txt" <<TXT
ai —— 终端里的 DeepSeek 对话框

【安装】把 Ai.app 拖到左边的「Applications」。

【首次打开】右键点 Ai.app → 打开（绕过未签名提示，仅首次需要）。
之后会弹出终端窗口。没填过 key 时，会引导你粘贴 DeepSeek API key
（到 https://platform.deepseek.com 申请，sk- 开头），回车保存，随即进入对话。

【想用命令行】双击「安装命令行 ai.command」，之后新开终端输入 ai 即可。

内置 Node 运行时，无需另装任何环境。版本 ${VERSION}。
TXT

# ——— 7. 生成 DMG ———
echo "▶ 生成 DMG"
rm -f "$DMG"
hdiutil create -volname "$VOLNAME" -srcfolder "$DMG_ROOT" \
  -ov -format UDZO "$DMG" >/dev/null

# 清理临时件（保留 node 缓存以便下次更快）
rm -rf "$WORK" "$DMG_ROOT"

echo ""
echo "✅ 完成: $DMG"
ls -lh "$DMG" | awk '{print "   大小:", $5}'
