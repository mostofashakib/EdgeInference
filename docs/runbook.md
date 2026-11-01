# EdgeInference Operations Runbook

## 1. System Overview & Architecture

EdgeInference provides a secure, self-hosted multimodal LLM inference service on Apple Silicon (M1 Max, 64GB RAM).

### Service Topology & Port Allocation

| Component | Process | Port / Socket | Bind Address | Supervision |
| :--- | :--- | :--- | :--- | :--- |
| **Ollama Inference Engine** | `ollama` (MLX runner) | `11434` | `127.0.0.1` | Ollama App / launchd |
| **Fastify Gateway** | `node dist/gateway/src/index.js` | `8765` | `127.0.0.1` | launchd (`com.edgeinference.gateway`) |
| **Nginx Reverse Proxy** | `nginx` | `8080` | `127.0.0.1` | launchd (`com.edgeinference.nginx`) |
| **Cloudflare Tunnel** | `cloudflared` | Outbound only | N/A | Cloudflare CLI / Daemon |

> [!IMPORTANT]
> All services bind strictly to `127.0.0.1`. No router ports are forwarded. External traffic reaches the system exclusively over an encrypted, outbound Cloudflare Tunnel protected by Cloudflare Access service tokens.

---

## 2. Startup & Shutdown Sequences

### 2.1 Startup Sequence (Dependency Order)

Services must start in the following order:

1. **Ollama Service**:
   ```bash
   # Verify Ollama is running and model qwen3.8:27b is available
   curl -s http://127.0.0.1:11434/api/tags | grep "qwen3.8:27b"
   ```
2. **Fastify Gateway**:
   ```bash
   # Development / Testing
   pnpm tsx gateway/src/index.ts
   # Production (via launchd)
   launchctl load ~/Library/LaunchAgents/com.edgeinference.gateway.plist
   ```
3. **Nginx Reverse Proxy**:
   ```bash
   # Start Nginx
   ./scripts/setup/manage-nginx.sh start
   # Or via launchd:
   launchctl load ~/Library/LaunchAgents/com.edgeinference.nginx.plist
   ```
4. **Cloudflare Tunnel**:
   ```bash
   cloudflared tunnel run edge-inference
   ```

### 2.2 Graceful Shutdown Sequence

Shut down services in reverse order to ensure ongoing requests complete:

1. **Cloudflare Tunnel**: Stop `cloudflared` (stops routing new external traffic).
2. **Nginx**: Stop proxy (`./scripts/setup/manage-nginx.sh stop` or `launchctl unload ~/Library/LaunchAgents/com.edgeinference.nginx.plist`).
3. **Gateway**: Send `SIGTERM` or unload launchd (`launchctl unload ~/Library/LaunchAgents/com.edgeinference.gateway.plist`). The Fastify gateway allows in-flight streaming requests up to `DRAIN_TIMEOUT_MS` (default 30 seconds) to terminate cleanly.
4. **Ollama**: Close Ollama if not running other models.

---

## 3. Health & Readiness Verification

Run the automated diagnostic suite:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm tsx scripts/verify/health-check.ts
```

### Manual Component Health Checks

1. **Ollama**:
   ```bash
   curl -s -i http://127.0.0.1:11434/api/tags
   # Expected: HTTP 200 OK with list of models including qwen3.8:27b
   ```
2. **Gateway**:
   ```bash
   curl -s -i http://127.0.0.1:8765/health
   # Expected: HTTP 200 OK with {"status":"healthy"}
   ```
3. **Nginx Proxy**:
   ```bash
   curl -s -i http://127.0.0.1:8080/health
   # Expected: HTTP 200 OK with {"status":"healthy"}
   ```
4. **End-to-End Synthetic Request**:
   ```bash
   curl -s -i http://127.0.0.1:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $LLM_API_SECRET" \
     -d '{
       "model": "qwen3.8:27b",
       "messages": [{"role": "user", "content": "ping"}],
       "max_tokens": 5
     }'
   ```

---

## 4. SQLite Quota Management & Backups

The SQLite quota database is stored in `data/quota.db` with write-ahead logging enabled (`WAL` mode).

### 4.1 Online Backup

SQLite WAL mode allows safe online backups while the service is running:

```bash
# Atomic online backup using sqlite3 CLI
sqlite3 data/quota.db ".backup 'data/backups/quota_backup_$(date +%Y%m%d_%H%M%S).db'"
```

### 4.2 Database Integrity Check

```bash
sqlite3 data/quota.db "PRAGMA integrity_check;"
# Expected output: ok
```

### 4.3 WAL Checkpoint & Vacuum

To truncate WAL logs and compact storage:

```bash
sqlite3 data/quota.db "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 data/quota.db "VACUUM;"
```

### 4.4 Emergency Quota Reset

If daily quota needs to be manually cleared for a key:

```bash
# Reset quota for all keys for today
sqlite3 data/quota.db "DELETE FROM daily_quotas WHERE date_key = date('now');"
```

---

## 5. Troubleshooting Playbook

### 5.1 HTTP 502 Bad Gateway (`upstream_inference_error`)

- **Symptom**: Client receives `502 Bad Gateway` with code `upstream_inference_error` or `upstream_unavailable`.
- **Cause**: Fastify cannot reach Ollama at `127.0.0.1:11434`, or Ollama crashed during execution.
- **Remediation**:
  1. Check Ollama process: `pgrep -x ollama` or `ps aux | grep ollama`.
  2. Verify VRAM usage: Open `Activity Monitor` -> Memory or run `sudo powermetrics --samplers gpu_power`.
  3. Restart Ollama and verify runner loads `qwen3.8:27b`.
  4. Test raw Ollama connectivity: `curl -s http://127.0.0.1:11434/api/tags`.

### 5.2 HTTP 429 Rate Limit / Concurrency Busy (`inference_busy` / `rate_limit_exceeded`)

- **Symptom**: Client receives `429 Too Many Requests`.
- **Diagnosis**:
  - If header contains `Retry-After` and body code is `rate_limit_exceeded`: Triggered by Nginx exceeding 6 req/min per IP. Back off client request frequency.
  - If body code is `inference_busy`: Fastify in-process admission controller has 1 active inference and 2 queued inferences. Wait for active generation to finish.
  - If body code is `quota_exceeded`: Daily request quota (100 req/day default) exhausted. Will reset at 00:00:00 UTC.

### 5.3 HTTP 401 Unauthorized (`unauthorized` / `missing_token`)

- **Symptom**: Client request rejected with HTTP 401.
- **Diagnosis**:
  - Missing `Authorization: Bearer <secret>` header.
  - Invalid secret token or mismatch with active secrets in `.env`.
  - Missing Cloudflare Access headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) when accessing via Cloudflare.

### 5.4 High Memory / VRAM Pressure

- **Symptom**: System becomes sluggish; swap activity increases.
- **Diagnosis**: M1 Max has 64GB unified memory. `qwen3.8:27b` nvfp4 requires ~20.1 GB VRAM.
- **Action**: Check background applications (e.g. video rendering, Docker containers). Ensure `OLLAMA_NUM_PARALLEL=1` in Ollama configuration to avoid allocating duplicate model contexts.

---

## 6. Secret Rotation Procedure

EdgeInference supports zero-downtime secret rotation:

1. Generate a new cryptographic secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `.env` to include both the existing and new secret:
   ```env
   LLM_API_SECRET="old_secret_hash,new_secret_hash"
   ```
3. Gracefully reload the gateway (`kill -HUP <pid>` or reload via launchd).
4. Update client applications to send the new secret.
5. Once clients have migrated, remove the old secret from `.env` and reload.

