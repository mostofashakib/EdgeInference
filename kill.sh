#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# EdgeInference — Process Killer
# Kills any running Nginx reverse proxy (:8080) and Fastify Gateway (:8765)
# processes. Safe to run at any time.
# ─────────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure standard Homebrew tools take priority
if [[ -d "/opt/homebrew/bin" ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $*"; }
info() { echo -e "  ${BOLD}·${RESET} $*"; }

echo ""
echo -e "${BOLD}Stopping EdgeInference processes...${RESET}"
echo ""

killed_any=false

# ── Kill by port ──────────────────────────────────────────────────────────────
kill_port() {
  local port="$1"
  local label="$2"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 0.5
    local remaining
    remaining=$(lsof -ti:"$port" 2>/dev/null || true)
    if [[ -n "$remaining" ]]; then
      echo "$remaining" | xargs kill -9 2>/dev/null || true
    fi
    ok "$label (port $port) stopped — PIDs: $pids"
    killed_any=true
  else
    info "Nothing running on port $port ($label)"
  fi
}

# 1. Stop Nginx cleanly via master process signal if PID file exists
NGINX_PID_FILE="$ROOT/infra/nginx/nginx.pid"
if [[ -f "$NGINX_PID_FILE" ]] && kill -0 "$(cat "$NGINX_PID_FILE")" 2>/dev/null; then
  nginx -p "$ROOT" -c "$ROOT/infra/nginx/nginx.conf" -s stop 2>/dev/null || true
  rm -f "$NGINX_PID_FILE"
  ok "Nginx gracefully stopped via signal"
  killed_any=true
fi

# 2. Clear ports
kill_port 8080 "Nginx Reverse Proxy"
kill_port 8765 "Fastify Gateway"

# ── Kill by process pattern (belt-and-suspenders) ─────────────────────────────
kill_pattern() {
  local pattern="$1"
  local label="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 0.3
    local remaining
    remaining=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [[ -n "$remaining" ]]; then
      echo "$remaining" | xargs kill -9 2>/dev/null || true
    fi
    ok "$label processes terminated — PIDs: $pids"
    killed_any=true
  fi
}

kill_pattern "tsx.*gateway/src/main"                  "Stray Fastify Gateway (tsx)"
kill_pattern "node.*dist/gateway/src/main"            "Stray Fastify Gateway (node)"
kill_pattern "nginx: master process.*infra/nginx"     "Stray Nginx master"
kill_pattern "nginx: worker process"                  "Stray Nginx worker"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ "$killed_any" == "true" ]]; then
  echo -e "${GREEN}${BOLD}All EdgeInference processes stopped.${RESET}"
else
  echo -e "${YELLOW}No EdgeInference processes were running.${RESET}"
fi
echo ""

