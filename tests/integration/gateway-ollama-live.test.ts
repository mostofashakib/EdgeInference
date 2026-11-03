import { hashSecretSha256 } from "../../gateway/src/client/cryptoAuth.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createApp, type AppDependencies } from "../../gateway/src/app.js";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";
import { SharpImageProcessor } from "../../gateway/src/infrastructure/images/SharpImageProcessor.js";
import { OllamaInferenceClient } from "../../gateway/src/infrastructure/ollama/OllamaInferenceClient.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import {
  FakeQuotaRepository,
  FakeAdmissionController,
  FakeClock,
  FakeMetricsRecorder
} from "../fakes/index.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL_NAME = process.env.LLM_MODEL || "qwen3.8:27b";

describe("M3 Gateway with Real Ollama Live Integration", () => {
  const secret = "b".repeat(64);
  let app: FastifyInstance;
  const fixturesDir = path.resolve(process.cwd(), "tests/fixtures/images");
  const shapesPngBase64 = fs.readFileSync(path.join(fixturesDir, "shapes.png")).toString("base64");

  beforeAll(async () => {
    // Check Ollama is reachable
    const ping = await fetch(`${OLLAMA_BASE_URL}/api/tags`).catch(() => null);
    if (!ping || !ping.ok) {
      throw new Error(`Ollama is not running at ${OLLAMA_BASE_URL}`);
    }

    const config = loadConfig({
      NODE_ENV: "test",
      LLM_API_SECRET: secret,
      ALLOWED_MODELS: MODEL_NAME,
      OLLAMA_BASE_URL
    });

    const authenticator = new BearerTokenAuthenticator([{ keyId: "live-key", secret }]);
    const inferenceClient = new OllamaInferenceClient(config.ollamaBaseUrl);
    const imageProcessor = new SharpImageProcessor({
      maxBytes: 4 * 1024 * 1024,
      maxMegapixels: 20,
      allowedFormats: ["jpeg", "png", "webp"]
    });

    const deps: AppDependencies = {
      config,
      authenticator,
      inferenceClient,
      quotaRepository: new FakeQuotaRepository(),
      admissionController: new FakeAdmissionController(),
      imageProcessor,
      clock: new FakeClock(),
      metricsRecorder: new FakeMetricsRecorder()
    };

    app = createApp(deps);
    await app.ready();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it("processes authenticated text generation request through gateway to real Ollama", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: "user", content: "Reply with exactly 'GATEWAY_TEST_OK'" }],
        temperature: 0.1
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.choices[0].message.content).toContain("GATEWAY_TEST_OK");
  }, 45000);

  it("processes authenticated multimodal image request through gateway to real Ollama", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${hashSecretSha256(secret)}` },
      payload: {
        model: MODEL_NAME,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What colors and shapes are in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${shapesPngBase64}` }
              }
            ]
          }
        ],
        temperature: 0.1
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const text = body.choices[0].message.content.toLowerCase();
    expect(text).toMatch(/red|square|rectangle/);
    expect(text).toMatch(/blue|circle/);
  }, 60000);

  it("rejects unauthorized request before reaching real Ollama", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer wrong_secret" },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: "user", content: "This should not reach Ollama" }]
      }
    });

    expect(res.statusCode).toBe(401);
  }, 10000);
});

