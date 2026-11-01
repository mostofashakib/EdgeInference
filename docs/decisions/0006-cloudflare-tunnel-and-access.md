# ADR 0006: Cloudflare Tunnel and Edge Service Authorization

## Status
Accepted

## Context
In Milestone 6, we establish external access for authorized backend applications without opening router firewall ports, exposing static public IP addresses, or directly routing untrusted Internet traffic to localhost.
Requirements:
- Outbound encrypted tunnel via `cloudflared`.
- Edge authorization via Cloudflare Access service tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).
- Origin-side Access credential verification (`CloudflareAccessValidator`).
- Strict separation of credentials: the edge Access service token and the application API Bearer secret must be completely distinct values.
- Neither credential set can bypass the other: an attacker possessing valid Cloudflare Access credentials still cannot perform inference without the private API Bearer secret.

## Decision

1. **Cloudflare Tunnel (`cloudflared`)**:
   - Outbound-only TLS connection established from the MacBook host to Cloudflare's edge network.
   - Tunnel ingress routes the public hostname (`llm.example.com`) directly to `http://127.0.0.1:8080` (Nginx), ensuring that rate limiting, body size enforcement, and route allowlisting occur before packets reach Fastify.
   - All other hostnames and unconfigured routes receive an immediate HTTP 404.
2. **Edge Service Authorization Policy**:
   - Cloudflare Access application configured with a `Service Auth` rule requiring valid `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
3. **Origin-Side Dual-Gate Enforcement**:
   - `Fastify`'s `onRequest` hook executes a 2-stage verification:
     1. Stage 1 (`CloudflareAccessValidator`): Validates presence and signature of Cloudflare Access service tokens.
     2. Stage 2 (`BearerTokenAuthenticator`): Performs constant-time comparison of the application Bearer API secret (`LLM_API_SECRET`).
   - Requests failing Stage 1 never reach Stage 2; requests failing Stage 2 never reach controller or GPU resources.
4. **Credential Rotation & Secret Management**:
   - Cloudflare service tokens are generated and managed via Cloudflare Zero Trust.
   - Bearer secrets are generated independently using cryptographic entropy (`openssl rand -hex 32`) and associate with internal key IDs.

## Consequences
- No incoming public ports are opened on the host or local network.
- Complete multi-layer defense: compromised Cloudflare service tokens alone cannot authorize inference; compromised Bearer secrets cannot bypass Cloudflare Access at the edge.

