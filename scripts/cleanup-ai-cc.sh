#!/bin/zsh
# Safe maintenance for ai-cc / ai-claude only. Never stops a paired active run.
set -u

export PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
DOCKER="$(command -v docker || true)"
[[ -n "$DOCKER" ]] || exit 0
"$DOCKER" info >/dev/null 2>&1 || exit 0

# Containers which have already stopped are safe to remove.
for prefix in ai-cc ai-claude; do
  "$DOCKER" ps -aq --filter 'status=exited' --filter "name=$prefix" | while IFS= read -r id; do
    [[ -n "$id" ]] && "$DOCKER" rm -f "$id" >/dev/null 2>&1 || true
  done
done

# An ai-cc proxy without its identically suffixed Claude container is stale.
"$DOCKER" ps -a --format '{{.Names}}' | while IFS= read -r proxy; do
  [[ "$proxy" == ai-cc-proxy-* ]] || continue
  suffix="${proxy#ai-cc-proxy-}"
  if ! "$DOCKER" ps -a --format '{{.Names}}' | grep -Fxq "ai-cc-${suffix}"; then
    "$DOCKER" rm -f "$proxy" >/dev/null 2>&1 || true
  fi
done

# Do not use global `docker network prune`; only delete empty private networks.
"$DOCKER" network ls --format '{{.Name}}' | while IFS= read -r network; do
  [[ "$network" == ai-cc-private-* || "$network" == ai-claude-private-* ]] || continue
  attached="$("$DOCKER" network inspect -f '{{len .Containers}}' "$network" 2>/dev/null || echo 1)"
  [[ "$attached" == 0 ]] && "$DOCKER" network rm "$network" >/dev/null 2>&1 || true
done
