import fs from "node:fs";
import path from "node:path";

// Centralize local configuration: automatically load .env if present
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

interface ServiceHealth {
  name: string;
  url: string;
  healthy: boolean;
  statusCode?: number;
  latencyMs: number;
  details?: string;
}

async function checkService(name: string, url: string, validator: (res: Response) => Promise<boolean>): Promise<ServiceHealth> {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const latencyMs = Math.round(performance.now() - start);
    const healthy = res.ok && (await validator(res));
    return {
      name,
      url,
      healthy,
      statusCode: res.status,
      latencyMs,
      details: healthy ? "Operating normally" : `Returned HTTP ${res.status}`
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      name,
      url,
      healthy: false,
      latencyMs,
      details: (err as Error).message
    };
  }
}

export async function runHealthCheck(): Promise<{
  allHealthy: boolean;
  services: ServiceHealth[];
}> {
  const services: ServiceHealth[] = [];
  const backend = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const models = (process.env.ALLOWED_MODELS ?? process.env.LLM_MODEL ?? "qwen3.8:27b").split(",").map((model) => model.trim());
  const configuredHost = process.env.HOST || "127.0.0.1";
  const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost === "::" ? "::1" : configuredHost;
  const gateway = `http://${host.includes(":") ? `[${host}]` : host}:${process.env.PORT || "8765"}`;

  // 1. Ollama Inference Engine
  services.push(
    await checkService("Ollama Engine", `${backend}/api/tags`, async (res) => {
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return models.every((model) => model.length > 0 && data.models?.some((entry) => entry.name === (model.includes(":") ? model : `${model}:latest`)));
    })
  );

  // 2. Fastify Gateway
  services.push(
    await checkService("Fastify Gateway", `${gateway}/health`, async (res) => {
      const data = (await res.json()) as { status?: string };
      return data.status === "healthy";
    })
  );

  // 3. Nginx Reverse Proxy
  services.push(
    await checkService("Nginx Reverse Proxy", "http://127.0.0.1:8080/health", async (res) => {
      const data = (await res.json()) as { status?: string };
      return data.status === "healthy";
    })
  );

  const allHealthy = services.every((s) => s.healthy);
  return { allHealthy, services };
}

if (process.argv[1]?.endsWith("health-check.ts") || process.argv[1]?.endsWith("health-check.js")) {
  console.log("=== EdgeInference System Health & Readiness Check ===");
  runHealthCheck().then((result) => {
    for (const s of result.services) {
      const statusIcon = s.healthy ? "[PASS]" : "[FAIL]";
      console.log(`${statusIcon} ${s.name} (${s.url}): ${s.details} (${s.latencyMs}ms)`);
    }
    console.log("-----------------------------------------------------");
    console.log(`Overall Health Status: ${result.allHealthy ? "READY" : "DEGRADED"}`);
    if (!result.allHealthy) {
      process.exitCode = 1;
    }
  });
}

