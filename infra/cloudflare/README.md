# Cloudflare Tunnel & Cloudflare Access Setup Guide

## 1. Architecture & Dual-Authentication Gate

```text
External Client
   |
   | HTTPS
   | CF-Access-Client-Id: <id>
   | CF-Access-Client-Secret: <secret>
   | Authorization: Bearer <LLM_API_SECRET>
   v
[Edge Boundary] Cloudflare Access (Service Auth Policy)
   |
   | Outbound Encrypted Tunnel (cloudflared)
   v
[Network Boundary] Nginx (127.0.0.1:8080)
   |
   | Reverse Proxy
   v
[Origin Boundary] Fastify Gateway (127.0.0.1:8765)
   - Checks Cloudflare Access headers (CF-Access-Client-Id / CF-Access-Client-Secret)
   - Checks timing-safe Application Bearer Secret (Authorization: Bearer <LLM_API_SECRET>)
   - Executes Zod request validation, quota accounting, and semaphore admission
```

## 2. Setting Up Cloudflare Tunnel

1. Authenticate `cloudflared`:
   ```bash
   cloudflared tunnel login
   ```
2. Create the tunnel:
   ```bash
   cloudflared tunnel create edge-inference
   ```
   Note the generated UUID.
3. Configure DNS route:
   ```bash
   cloudflared tunnel route dns edge-inference llm.example.com
   ```
4. Copy `infra/cloudflare/config.example.yml` to `infra/cloudflare/config.yml` and insert your tunnel UUID.
5. Validate configuration:
   ```bash
   cloudflared tunnel ingress validate --config infra/cloudflare/config.yml
   ```
6. Run tunnel:
   ```bash
   cloudflared tunnel --config infra/cloudflare/config.yml run
   ```

## 3. Creating Service Token in Cloudflare Zero Trust

1. Navigate to **Zero Trust Dashboard > Access > Service Credentials**.
2. Click **Add Service Token**. Name it `edge-inference-client`.
3. Save the generated `Client ID` and `Client Secret`.
4. Create an Access Application for `llm.example.com`.
5. Add a Policy with Action `Service Auth` that matches this Service Token.

## 4. Secret Separation & Rotation Protocol

- **Different Secrets**: `CF_ACCESS_CLIENT_SECRET` and `LLM_API_SECRET` must NEVER be identical.
- **Rotation Procedure**:
  1. Generate new secondary token in Cloudflare Access.
  2. Set `LLM_API_SECRET_PREVIOUS` to old gateway secret and `LLM_API_SECRET` to new secret.
  3. Deploy updated environment to the client application.
  4. Revoke previous service token in Cloudflare Access dashboard.
  5. Verify that revoked credentials return HTTP 401/403.

