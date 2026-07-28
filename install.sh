#!/bin/sh
set -eu

REPOSITORY="${AI_REMOTE_REPOSITORY:-https://github.com/lteu/agent}"
REVISION="${AI_REMOTE_REVISION:-main}"
INSTALL_ROOT="${AI_REMOTE_INSTALL_DIR:-$HOME/.local/share/ai-remote}"
BIN_DIR="${AI_REMOTE_BIN_DIR:-$HOME/.local/bin}"
APP_DIR="$INSTALL_ROOT/app"
ARCHIVE_URL="${AI_REMOTE_ARCHIVE_URL:-${REPOSITORY%/}/archive/refs/heads/$REVISION.tar.gz}"

fail() {
  printf 'ai-remote installer: %s\n' "$*" >&2
  exit 1
}

for command_name in node npm curl tar; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "缺少 $command_name，请先安装 Node.js 20+、npm、curl 和 tar"
done

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 20 ] ||
  fail "需要 Node.js 20 或更高版本，当前版本为 $(node --version)"

case "$INSTALL_ROOT" in
  ""|"/"|"$HOME") fail "AI_REMOTE_INSTALL_DIR 不能是空值、/ 或 HOME 目录" ;;
esac

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-remote-install.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

printf '正在下载 ai-remote (%s)...\n' "$REVISION"
curl -fL --retry 3 --connect-timeout 15 "$ARCHIVE_URL" -o "$WORK_DIR/source.tar.gz" ||
  fail "下载失败：$ARCHIVE_URL"

mkdir -p "$WORK_DIR/source"
tar -xzf "$WORK_DIR/source.tar.gz" --strip-components=1 -C "$WORK_DIR/source"

printf '正在安装依赖并构建...\n'
(
  cd "$WORK_DIR/source"
  npm ci --no-audit --no-fund </dev/null
  npm run build:remote </dev/null
  npm prune --omit=dev --no-audit --no-fund </dev/null
)

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
rm -rf "$INSTALL_ROOT/app.new"
mv "$WORK_DIR/source" "$INSTALL_ROOT/app.new"
if [ -d "$APP_DIR" ]; then
  rm -rf "$INSTALL_ROOT/app.previous"
  mv "$APP_DIR" "$INSTALL_ROOT/app.previous"
fi
mv "$INSTALL_ROOT/app.new" "$APP_DIR"

cat >"$BIN_DIR/ai-remote" <<EOF
#!/bin/sh
exec node "$APP_DIR/dist/remote.js" "\$@"
EOF
chmod 0755 "$BIN_DIR/ai-remote"

printf '\n✓ ai-remote 已安装到 %s\n' "$APP_DIR"
printf '  命令位置：%s/ai-remote\n' "$BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n请将下面一行加入 ~/.zshrc 或 ~/.bashrc，然后重新打开终端：\n'
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\n当前服务默认通过 SSH 访问。首次运行前请确认 `ssh remote` 可以登录，\n'
printf '或设置 AI_REMOTE_SSH_HOST；如果以后启用公网 HTTPS，可设置 AI_REMOTE_URL。\n'
printf '\n验证：ai-remote usage\n'
