#!/bin/sh
set -eu

ssh \
  -o BatchMode=yes \
  -o IgnoreUnknown=UseKeychain \
  -o ExitOnForwardFailure=yes \
  -o ForwardAgent=no \
  -o TCPKeepAlive=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=2 \
  -o ConnectTimeout=15 \
  -N \
  -D 127.0.0.1:1080 \
  "$@" &
ssh_pid=$!

cleanup() {
  kill "$ssh_pid" 2>/dev/null || true
  wait "$ssh_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

exec privoxy --no-daemon /etc/privoxy/ai-cc.conf
