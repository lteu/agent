#!/usr/bin/env bash
#
# 打包成可分发的 macOS .dmg：内置 Node 运行时 + 应用代码。
# 双击 Ai.app 即在终端进入对话；缺 key 会引导输入。
# （想要「装好就有 ai 命令」的一键安装，用 make-pkg.sh 生成 .pkg。）
#
# 用法:  npm run dmg                 (ARCH=arm64|x64|universal)
# 产物:  dist/ai-<version>-<arch>.dmg
#
set -euo pipefail

ARCH="${ARCH:-arm64}"
APP_NAME="Ai"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
DIST="$ROOT/dist"
WORK="$DIST/_pkg"
DMG_ROOT="$DIST/_dmgroot"
APP="$WORK/$APP_NAME.app"
DMG="$DIST/ai-$VERSION-$ARCH.dmg"   # 架构进文件名，避免互相覆盖
VOLNAME="ai $VERSION"

echo "▶ 打包 DMG  ai $VERSION ($ARCH)"
rm -rf "$WORK" "$DMG_ROOT"
mkdir -p "$WORK"

# 1) 组装 .app（共用脚本）
bash "$HERE/build-app.sh" "$APP"

# 2) 组 DMG 内容：Ai.app + Applications 快捷方式 + 一键安装命令脚本 + 说明
echo "▶ 组装 DMG 内容"
mkdir -p "$DMG_ROOT"
cp -R "$APP" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"

# 「① 安装 ai 命令」：拖好 Ai.app 后双击它，把 ai 装成终端命令
cat > "$DMG_ROOT/① 安装 ai 命令.command" <<'INSTALL'
#!/bin/bash
# 把 Applications 里的 Ai.app 暴露成终端命令 `ai`
set -e
APP="/Applications/Ai.app"
[ -d "$APP" ] || { echo "✋ 请先把 Ai.app 拖进「应用程序」，再运行本脚本"; echo "按任意键关闭"; read -n 1 -s; exit 1; }
# 优先装到 /usr/local/bin（各机型默认都在 PATH 里）；没权限就退回 ~/.local/bin
TARGET="/usr/local/bin"
if [ -w "$TARGET" ] || mkdir -p "$TARGET" 2>/dev/null && [ -w "$TARGET" ]; then :; else
  echo "（/usr/local/bin 需要管理员权限，下面可能让你输入登录密码）"
  if sudo mkdir -p "$TARGET" 2>/dev/null; then SUDO=sudo; else TARGET="$HOME/.local/bin"; mkdir -p "$TARGET"; fi
fi
WRAP="$(mktemp)"
cat > "$WRAP" <<EOF
#!/bin/bash
RES="$APP/Contents/Resources"
M="\$(uname -m)"; [ "\$M" = "x86_64" ] && M="x64"
NODE="\$RES/node-\$M"; [ -x "\$NODE" ] || NODE="\$(ls "\$RES"/node-* | head -1)"
exec "\$NODE" "\$RES/app/cli.js" "\$@"
EOF
chmod +x "$WRAP"
${SUDO:-} cp "$WRAP" "$TARGET/ai"; rm -f "$WRAP"
echo "✅ 已安装：$TARGET/ai"
case ":$PATH:" in
  *":$TARGET:"*) echo "现在新开一个终端，输入 ai 即可。";;
  *) echo "把它加入 PATH： echo 'export PATH=\"$TARGET:\$PATH\"' >> ~/.zshrc，然后新开终端。";;
esac
echo "按任意键关闭"; read -n 1 -s
INSTALL
chmod +x "$DMG_ROOT/① 安装 ai 命令.command"

# 说明
cat > "$DMG_ROOT/使用说明.txt" <<TXT
ai —— 终端里的 DeepSeek 对话框

【一步装好】
  1. 把 Ai.app 拖进左边的「Applications」。
  2. 双击「① 安装 ai 命令.command」（首次右键→打开以绕过未签名提示）。
     之后新开终端输入 ai 就能用。
  （只想点图标用也行：右键 Ai.app →打开。）

【首次使用】没填过 key 时会引导你粘贴 DeepSeek API key
（到 https://platform.deepseek.com 申请，sk- 开头），回车保存后进入对话。

内置 Node 运行时，无需另装任何环境。版本 ${VERSION}。

★ 想要双击就装好、自动带 ai 命令？改用 .pkg 安装包（见项目 README）。
TXT

# 3) 生成 DMG
echo "▶ 生成 DMG"
rm -f "$DMG"
hdiutil create -volname "$VOLNAME" -srcfolder "$DMG_ROOT" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$WORK" "$DMG_ROOT"

echo ""
echo "✅ 完成: $DMG"
ls -lh "$DMG" | awk '{print "   大小:", $5}'
