import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { execSync } from "node:child_process";
import path from "node:path";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeInferenceClient,
  FakeQuotaRepository,
  FakeAdmissionController,
  FakeImageProcessor,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

describe("M5 Nginx Reverse Proxy & Network Limits", () => {
  const secret = "d".repeat(64);
  const nginxUrl = "http://127.0.0.1:8080";
  const scriptPath = path.resolve(process.cwd(), "scripts/setup/manage-nginx.sh");

  let gatewayApp: FastifyInstance;
  let fakeClient: FakeInferenceClient;

  beforeAll(async () => {
    // 1. Start Fastify gateway listening on 127.0.0.1:8765
    fakeClient = new FakeInferenceClient();
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "8765",
      HOST: "127.0.0.1",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: "qwen3.8:27b"
    });

    const deps: AppDependencies = {
      config,
      authenticator: new BearerTokenAuthenticator([{ keyId: "test-key", secret, role: "owner" }]),
      inferenceClient: fakeClient,
      quotaRepository: new FakeQuotaRepository(),
      admissionController: new FakeAdmissionController(),
      imageProcessor: new FakeImageProcessor(),
      clock: new FakeClock(),
      metricsRecorder: new FakeMetricsRecorder()
    };

    gatewayApp = createApp(deps);
    await gatewayApp.listen({ port: 8765, host: "127.0.0.1" });

    // 2. Start Nginx
    execSync(`${scriptPath} stop`, { stdio: "ignore" });
    execSync(`${scriptPath} start`, { stdio: "inherit" });
  }, 15000);

  afterAll(async () => {
    // 1. Stop Nginx
    try {
      execSync(`${scriptPath} stop`, { stdio: "ignore" });
    } catch {
      // ignore
    }

    // 2. Stop Gateway
    if (gatewayApp) {
      await gatewayApp.close();
    }
  });

  it("proxies valid chat completion request through Nginx to gateway", async () => {
    const res = await fetch(`${nginxUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`
      },
      body: JSON.stringify({
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Hello through Nginx" }]
      })
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("Hello from FakeInferenceClient!");
    expect(fakeClient.generateCallCount).toBe(1);
  });

  it("proxies unauthenticated health check through Nginx", async () => {
    const res = await fetch(`${nginxUrl}/health`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("healthy");
  });

  it("serves friendly service discovery response on GET / for browsers", async () => {
    const res = await fetch(`${nginxUrl}/`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; status: string };
    expect(body.service).toBe("EdgeInference");
    expect(body.status).toBe("online");
  });

  it("rejects unauthorized routes with HTTP 404 and structured JSON error", async () => {
    const res = await fetch(`${nginxUrl}/api/tags`, {
      method: "GET"
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects unallowed HTTP methods on /v1/chat/completions with HTTP 405", async () => {
    const res = await fetch(`${nginxUrl}/v1/chat/completions`, {
      method: "GET"
    });

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });

  it("rejects unallowed HTTP methods on /health with HTTP 405", async () => {
    const res = await fetch(`${nginxUrl}/health`, {
      method: "POST",
      body: JSON.stringify({})
    });

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });

  it("streams SSE tokens unbuffered through Nginx", async () => {
    const res = await fetch(`${nginxUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`
      },
      body: JSON.stringify({
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "Stream through Nginx" }],
        stream: true
      })
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: {\"id\":\"fake-chatcmpl-123\"");
    expect(text).toContain("data: [DONE]");
    expect(fakeClient.streamCallCount).toBe(1);
  });

  it("allows local owner requests to bypass Nginx rate limit without throttling", async () => {
    // Send 6 rapid requests as local owner - all should succeed without 429
    const results = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${nginxUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${secret}`
        },
        body: JSON.stringify({
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: `Owner burst test ${i}` }]
        })
      });
      results.push(res.status);
    }

    // Owner is never rate limited
    expect(results).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("enforces Nginx request rate limit (6r/m burst 3) for guest/non-owner returning HTTP 429", async () => {
    // Send rapid requests as non-owner (X-Client-Role: guest); burst allows 3, initial allows 1, excess trips 429
    const results = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${nginxUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${secret}`,
          "X-Client-Role": "guest"
        },
        body: JSON.stringify({
          model: "qwen3.8:27b",
          messages: [{ role: "user", content: `Guest burst test ${i}` }]
        })
      });
      results.push(res.status);
    }

    // At least one request must have been rejected with 429
    expect(results).toContain(429);
  });

  it("returns controlled HTTP 502 bad gateway when upstream gateway is stopped", async () => {
    // Temporarily close gateway
    await gatewayApp.close();

    const res = await fetch(`${nginxUrl}/health`, { method: "GET" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("bad_gateway");
    expect(body.error.type).toBe("server_error");
  });
});
