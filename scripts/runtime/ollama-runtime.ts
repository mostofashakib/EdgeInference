import { setTimeout as delay } from "node:timers/promises";
import { resolveExecutable, type HostPlatform } from "./host-runtime.js";
import type { ServiceCommand } from "./service-supervisor.js";

async function probeBackend(baseUrl: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/version`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500)
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const result = await response.json() as { version?: unknown };
  if (typeof result.version !== "string") throw new Error("Endpoint did not return an Ollama version");
}

export async function getOllamaService(
  baseUrl: string,
  host: HostPlatform,
  env: NodeJS.ProcessEnv
): Promise<ServiceCommand | undefined> {
  try {
    await probeBackend(baseUrl);
    return undefined;
  } catch (error) {
    const url = new URL(baseUrl);
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && url.pathname === "/" && !url.search && !url.username && !url.password;
    const cause = (error as Error).cause as { code?: string } | undefined;
    if (!local || cause?.code !== "ECONNREFUSED") {
      throw new Error(`Ollama at ${baseUrl} is unavailable: ${(error as Error).message}`, { cause: error });
    }
    return {
      name: "ollama", command: resolveExecutable("ollama", host, env), args: ["serve"],
      env: { ...env, OLLAMA_HOST: url.host },
      ready: async (signal) => {
        const deadline = Date.now() + 30_000;
        while (!signal.aborted && Date.now() < deadline) {
          try { await probeBackend(baseUrl, signal); return; } catch (error) {
            const failure = (error as Error).cause as { code?: string } | undefined;
            if (failure?.code !== "ECONNREFUSED") throw error;
          }
          await delay(200, undefined, { signal });
        }
        throw new Error(`Local Ollama did not start at ${baseUrl}`);
      }
    };
  }
}
