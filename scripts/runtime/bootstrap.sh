#!/usr/bin/env bash
# Shared Node lookup for the start and stop entry points. Do not load .env here.
edge_find_node() {
  local candidate major machine
  local -a candidates
  candidates=()
  candidate="$(command -v node 2>/dev/null || true)"
  [[ -n "$candidate" ]] && candidates+=("$candidate")
  if [[ -x /usr/bin/uname ]]; then
    machine="$(/usr/bin/uname -m)"
  else
    machine="$(uname -m 2>/dev/null || true)"
  fi
  if [[ "$machine" == arm64 || "$machine" == aarch64 ]]; then
    candidates+=(/opt/homebrew/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/bin/node /usr/local/opt/node@24/bin/node)
  else
    candidates+=(/usr/local/bin/node /usr/local/opt/node@24/bin/node /opt/homebrew/bin/node /opt/homebrew/opt/node@24/bin/node)
  fi
  candidates+=(/usr/bin/node /bin/node)
  [[ -n "${NVM_BIN:-}" ]] && candidates+=("$NVM_BIN/node")
  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || continue
    case "$major" in ''|*[!0-9]*) continue ;; esac
    if [[ "$major" -ge 24 ]]; then
      EDGE_NODE_EXECUTABLE="$candidate"
      return 0
    fi
  done
  printf '%s\n' 'EdgeInference requires Node.js 24 or newer. Install it or add its bin directory to PATH.' >&2
  return 1
}
