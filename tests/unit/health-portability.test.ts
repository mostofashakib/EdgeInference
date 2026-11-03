import { afterEach, expect, it, vi } from "vitest";
import { runHealthCheck } from "../../scripts/verify/health-check.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("checks the configured remote backend, every allowed model, and gateway port", async () => {
  vi.stubEnv("OLLAMA_BASE_URL", "http://remote:11435");
  vi.stubEnv("ALLOWED_MODELS", "small:latest,other:latest");
  vi.stubEnv("PORT", "9000");
  vi.stubGlobal("fetch", async () => Response.json({ models: [{ name: "small:latest" }], status: "healthy" }));
  const result = await runHealthCheck();
  expect(result.services[0]?.url).toBe("http://remote:11435/api/tags");
  expect(result.services[0]?.healthy).toBe(false);
  expect(result.services[1]?.url).toBe("http://127.0.0.1:9000/health");
});
