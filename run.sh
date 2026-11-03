#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# EdgeInference — Local Development & Service Runner
# Kills any existing processes on :8080/:8765, ensures Ollama is running with
# qwen3.8:27b, launches Fastify Gateway, and starts Nginx Reverse Proxy.
# Ctrl+C gracefully stops all managed processes.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure Node 24 and standard Homebrew tools take priority
if [[ -d "/opt/homebrew/bin" ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
if [[ -d "/opt/homebrew/opt/node@24/bin" ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${BOLD}[edgeinference]${RESET} $*"; }
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }
err()  { echo -e "${RED}  ✗${RESET} $*"; }

# ── Options & Flags ──────────────────────────────────────────────────────────
ENABLE_TUNNEL=false
for arg in "$@"; do
  if [[ "$arg" == "--tunnel" || "$arg" == "-t" ]]; then
    ENABLE_TUNNEL=true
  fi
done

# ── Prefixed log streams ──────────────────────────────────────────────────────
gateway_log() { while IFS= read -r line; do echo -e "${CYAN}[gateway]${RESET} $line"; done; }
nginx_log()   { while IFS= read -r line; do echo -e "${GREEN}[nginx]  ${RESET} $line"; done; }
ollama_log()  { while IFS= read -r line; do echo -e "${MAGENTA}[ollama] ${RESET} $line"; done; }
tunnel_log()  { while IFS= read -r line; do echo -e "${YELLOW}[tunnel] ${RESET} $line"; done; }

# ── Kill a port — uses nc for a fast check, lsof only to get the PIDs ────────
kill_port() {
  local port="$1" label="$2"
  if ! nc -z 127.0.0.1 "$port" 2>/dev/null; then return; fi
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 0.4
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    [[ -n "$pids" ]] && echo "$pids" | xargs kill -9 2>/dev/null || true
    ok "Cleared $label (port $port)"
  fi
}

# ── Cleanup on Ctrl+C / TERM ─────────────────────────────────────────────────
GATEWAY_PID=""
NGINX_PID_FILE="$ROOT/infra/nginx/nginx.pid"
SPAWNED_OLLAMA_PID=""
TUNNEL_PID=""
TUNNEL_LOG=""
GLOBAL_URL=""

cleanup() {
  echo ""
  log "Shutting down EdgeInference services..."

  # Stop Cloudflare Tunnel
  if [[ -n "$TUNNEL_PID" ]]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$TUNNEL_LOG" && -f "$TUNNEL_LOG" ]]; then
    rm -f "$TUNNEL_LOG"
  fi
  pgrep -f "cloudflared.*tunnel.*8080" 2>/dev/null | xargs kill -9 2>/dev/null || true

  # Stop Gateway
  if [[ -n "$GATEWAY_PID" ]]; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi

  # Stop Nginx
  if [[ -f "$NGINX_PID_FILE" ]] && kill -0 "$(cat "$NGINX_PID_FILE")" 2>/dev/null; then
    nginx -p "$ROOT" -c "$ROOT/infra/nginx/nginx.conf" -s stop 2>/dev/null || true
    rm -f "$NGINX_PID_FILE"
  fi
  kill_port 8080 "nginx"

  # Stop Ollama only if run.sh spawned it
  if [[ -n "$SPAWNED_OLLAMA_PID" ]]; then
    kill "$SPAWNED_OLLAMA_PID" 2>/dev/null || true
  fi

  # Clean up any stray gateway processes
  pgrep -f "tsx.*gateway/src/main" 2>/dev/null | xargs kill -9 2>/dev/null || true
  pgrep -f "node.*dist/gateway/src/main" 2>/dev/null | xargs kill -9 2>/dev/null || true

  ok "All services stopped cleanly"
  exit 0
}
trap cleanup INT TERM

# ── Clear any running instances on EdgeInference ports ───────────────────────
log "Clearing any conflicting processes..."
kill_port 8080 "nginx"
kill_port 8765 "gateway"
pgrep -f "tsx.*gateway/src/main" 2>/dev/null | xargs kill -9 2>/dev/null || true
pgrep -f "node.*dist/gateway/src/main" 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── Centralized .env validation ──────────────────────────────────────────────
ENV_FILE="$ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  warn ".env not found — creating one from .env.example with secure random secret..."
  cp "$ROOT/.env.example" "$ENV_FILE"
  RANDOM_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  sed -i '' "s/replace_with_64_character_hex_random_secret/$RANDOM_SECRET/g" "$ENV_FILE" 2>/dev/null || \
  sed -i "s/replace_with_64_character_hex_random_secret/$RANDOM_SECRET/g" "$ENV_FILE"
  ok "Created local .env with 256-bit API secret"
fi

# Load variables into environment
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# Alias Cloudflare Tunnel environment variables
CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-${CF_TUNNEL_TOKEN:-}}"
CLOUDFLARE_TUNNEL_DOMAIN="${CLOUDFLARE_TUNNEL_DOMAIN:-${CF_TUNNEL_DOMAIN:-}}"
CLOUDFLARE_TUNNEL_ENABLED="${CLOUDFLARE_TUNNEL_ENABLED:-${CF_TUNNEL_ENABLED:-false}}"

# Enable tunnel if configured in .env or passed via CLI
if [[ "${TUNNEL:-false}" == "true" || "${CLOUDFLARE_TUNNEL_ENABLED:-false}" == "true" || -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  ENABLE_TUNNEL=true
fi

# ── Ensure dependencies are installed ────────────────────────────────────────
if [[ ! -d "$ROOT/node_modules" ]]; then
  log "node_modules missing — installing dependencies via pnpm..."
  pnpm install --frozen-lockfile
  ok "Dependencies installed"
fi

# Ensure data and log directories exist
mkdir -p "$ROOT/data" "$ROOT/infra/nginx"

# ── Ollama Verification & Startup ─────────────────────────────────────────────
OLLAMA_HOST_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
TARGET_MODEL="${LLM_MODEL:-qwen3.8:27b}"

log "Checking Ollama inference engine on $OLLAMA_HOST_URL..."
if ! nc -z 127.0.0.1 11434 2>/dev/null; then
  if command -v ollama &>/dev/null; then
    warn "Ollama is not running — starting 'ollama serve' in background..."
    ollama serve >/tmp/edgeinference-ollama.log 2>&1 &
    SPAWNED_OLLAMA_PID=$!
    for _ in $(seq 1 30); do
      if nc -z 127.0.0.1 11434 2>/dev/null; then break; fi
      sleep 0.2
    done
  else
    err "Ollama is not installed or not running on 127.0.0.1:11434."
    err "Install Ollama or run: brew install ollama"
    exit 1
  fi
fi

# Verify model presence
if curl -s "$OLLAMA_HOST_URL/api/tags" | grep -q "$TARGET_MODEL"; then
  ok "Ollama ready with model ${BOLD}$TARGET_MODEL${RESET}"
else
  warn "Model '$TARGET_MODEL' not found in Ollama."
  log "Pulling $TARGET_MODEL (this may take a few minutes)..."
  ollama pull "$TARGET_MODEL"
  ok "Model $TARGET_MODEL downloaded"
fi

# ── Start Fastify Gateway ─────────────────────────────────────────────────────
GATEWAY_PORT="${PORT:-8765}"
log "Starting Fastify Gateway on ${CYAN}http://127.0.0.1:$GATEWAY_PORT${RESET}"

(
  cd "$ROOT"
  exec pnpm tsx gateway/src/main.ts 2>&1
) | gateway_log &
GATEWAY_PID=$!

# Wait for Gateway readiness
for _ in $(seq 1 40); do
  if curl -s "http://127.0.0.1:$GATEWAY_PORT/health" 2>/dev/null | grep -q '"status":"healthy"'; then
    break
  fi
  sleep 0.2
done

if ! curl -s "http://127.0.0.1:$GATEWAY_PORT/health" 2>/dev/null | grep -q '"status":"healthy"'; then
  err "Fastify Gateway failed to become healthy on port $GATEWAY_PORT"
  cleanup
fi
ok "Fastify Gateway healthy (pid $GATEWAY_PID)"

# ── Start Nginx Reverse Proxy ────────────────────────────────────────────────
log "Starting Nginx Reverse Proxy on ${GREEN}http://127.0.0.1:8080${RESET}"

# Test Nginx configuration first
nginx -p "$ROOT" -t -c "$ROOT/infra/nginx/nginx.conf" >/dev/null 2>&1
nginx -p "$ROOT" -c "$ROOT/infra/nginx/nginx.conf"

# Wait for Nginx readiness
for _ in $(seq 1 20); do
  if curl -s "http://127.0.0.1:8080/health" 2>/dev/null | grep -q '"status":"healthy"'; then
    break
  fi
  sleep 0.1
done

if ! curl -s "http://127.0.0.1:8080/health" 2>/dev/null | grep -q '"status":"healthy"'; then
  err "Nginx failed to start on port 8080"
  cleanup
fi
ok "Nginx Reverse Proxy ready on port 8080"

# ── Optional Cloudflare Tunnel for Global Multi-Device Access ────────────────
if [[ "$ENABLE_TUNNEL" == "true" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    warn "cloudflared is not installed. Run 'brew install cloudflared' to enable global access across devices."
  else
    log "Starting Cloudflare Tunnel for global access across all devices..."
    TUNNEL_LOG=$(mktemp -t edgeinference-tunnel.XXXXXX)

    if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
      # Permanent Named Tunnel with custom domain
      ( cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" 2>&1 ) | tunnel_log &
      TUNNEL_PID=$!
      GLOBAL_URL="https://${CLOUDFLARE_TUNNEL_DOMAIN:-llm.yourdomain.com}"
      ok "Cloudflare Permanent Tunnel connected ($GLOBAL_URL)"
    else
      # Quick Tunnel (Instant public HTTPS URL on trycloudflare.com)
      cloudflared tunnel --url http://127.0.0.1:8080 > "$TUNNEL_LOG" 2>&1 &
      TUNNEL_PID=$!

      # Wait up to 10 seconds for the public trycloudflare.com URL
      for _ in $(seq 1 50); do
        GLOBAL_URL=$(grep -o 'https://[-a-zA-Z0-9\.]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1 || true)
        if [[ -n "$GLOBAL_URL" ]]; then
          break
        fi
        sleep 0.2
      done

      if [[ -n "$GLOBAL_URL" ]]; then
        ok "Cloudflare Quick Tunnel ready ($GLOBAL_URL)"
      else
        warn "Could not extract Quick Tunnel URL within 10s (tunnel running in background)"
      fi
    fi
  fi
fi

# ── Ready Banner ─────────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}${GREEN}✔ EdgeInference is running & ready for requests${RESET}"
echo ""
if [[ -n "$GLOBAL_URL" ]]; then
echo -e "  ${BOLD}🌐 Global Access (All Devices / Internet):${RESET}"
echo -e "     ${CYAN}Browser Test Link (Click to test)   ${RESET} → ${CYAN}${BOLD}$GLOBAL_URL/health${RESET}"
echo -e "     ${CYAN}OpenAI Base URL (For SDKs / Apps)   ${RESET} → ${CYAN}$GLOBAL_URL/v1${RESET}"
echo -e "     ${CYAN}Chat Endpoint (POST requests only)  ${RESET} → ${CYAN}$GLOBAL_URL/v1/chat/completions${RESET}"
echo ""
fi
echo -e "  ${BOLD}💻 Local Access (This Machine):${RESET}"
echo -e "     ${GREEN}Browser Test Link (Click to test)   ${RESET} → ${GREEN}http://127.0.0.1:8080/health${RESET}"
echo -e "     ${GREEN}OpenAI Base URL (For SDKs / Apps)   ${RESET} → ${GREEN}http://127.0.0.1:8080/v1${RESET}"
echo -e "     ${GREEN}Chat Endpoint (POST requests only)  ${RESET} → ${GREEN}http://127.0.0.1:8080/v1/chat/completions${RESET}"
echo ""
echo -e "  ${MAGENTA}Target Model         ${RESET} → $TARGET_MODEL (100% Metal GPU)"
echo -e "  ${YELLOW}Bearer Secret        ${RESET} → Loaded from local .env (HMAC/Pre-hash supported)"
if [[ "$ENABLE_TUNNEL" == "false" ]]; then
echo -e "  ${BOLD}Global Access Hint   ${RESET} → Run ${CYAN}./run.sh --tunnel${RESET} for global HTTPS access on any device"
fi
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop all services"
echo ""

# ── Wait for background processes ────────────────────────────────────────────
wait "$GATEWAY_PID"
