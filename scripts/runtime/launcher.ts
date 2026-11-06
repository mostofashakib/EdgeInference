import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AppConfigSchema, loadConfig, type AppConfig } from "../../gateway/src/config/AppConfig.js";
import { runEnvironmentAudit } from "../verify/audit-environment.js";
import { checkModelReadiness } from "../verify/model-readiness.js";
import { detectHost, resolveExecutable } from "./host-runtime.js";
import { getOllamaService } from "./ollama-runtime.js";
import { stopRunningServices } from "./service-cleanup.js";
import { runServices, controlEndpoint, type ServiceCommand } from "./service-supervisor.js";

const PROXY_PORT = 8080;

function stopEverything(root: string, endpoint: string): Promise<string[]> {
  return stopRunningServices({
    endpoint, root, proxyPort: PROXY_PORT,
    // Stopping must work without the secrets a full config requires.
    ports: [PROXY_PORT, AppConfigSchema.shape.port.parse(process.env.PORT)],
    tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.CF_TUNNEL_TOKEN
  });
}

function gatewayHost(config: AppConfig): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  return host.includes(":") ? `[${host}]` : host;
}

export function renderNginxConfig(source: string, config: AppConfig): string {
  const tempPaths = ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]
    .map((name) => `    ${name}_temp_path data/nginx/${name};`).join("\n");
  return `error_log infra/nginx/error.log warn;\n${source}`
    .replace("server 127.0.0.1:8765;", `server ${gatewayHost(config)}:${config.port};`)
    .replace("http {", `http {\n${tempPaths}`);
}

async function waitForHealth(url: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (response.ok && (await response.json() as { status?: string }).status === "healthy") return;
    } catch {
      // Connection refusal is expected while a child starts listening.
    }
    await delay(200, undefined, { signal });
  }
  throw new Error(`Service did not become healthy: ${url}`);
}

export function createServiceCommands(
  config: AppConfig,
  root: string,
  tunnel: boolean,
  env: NodeJS.ProcessEnv,
  executables: { nginx: string; cloudflared?: string }
): ServiceCommand[] {
  const commands: ServiceCommand[] = [
    {
      name: "gateway", command: process.execPath,
      args: ["--import", "tsx", path.join(root, "gateway/src/main.ts")],
      ready: (signal) => waitForHealth(`http://${gatewayHost(config)}:${config.port}/health`, signal)
    },
    {
      name: "nginx", command: executables.nginx,
      args: ["-p", `${root.replaceAll("\\", "/")}/`, "-e", "infra/nginx/error.log", "-c", "data/runtime-nginx.conf", "-g", "daemon off;"],
      ready: (signal) => waitForHealth("http://127.0.0.1:8080/health", signal),
      shutdown: async () => {
        await promisify(execFile)(executables.nginx, ["-p", `${root.replaceAll("\\", "/")}/`, "-e", "infra/nginx/error.log", "-c", "data/runtime-nginx.conf", "-s", "stop"], { timeout: 5000 });
      }
    }
  ];
  if (tunnel) {
    if (!executables.cloudflared) throw new Error("Cloudflare tunnel requires a detected cloudflared executable");
    const token = env.CLOUDFLARE_TUNNEL_TOKEN || env.CF_TUNNEL_TOKEN;
    // cloudflared logs unrecognized CF_* variables, including our token alias.
    const privateVariables = ["CF_TUNNEL_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "CF_ACCESS_CLIENT_SECRET",
      "LLM_API_SECRET", "LLM_API_SECRET_PREVIOUS", "LLM_GUEST_API_KEYS"];
    const tunnelEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !privateVariables.includes(name.toUpperCase())));
    commands.push({ name: "cloudflared", command: executables.cloudflared, env: tunnelEnv, args: token
      ? ["tunnel", "run", "--token", token]
      : ["tunnel", "--url", "http://127.0.0.1:8080"] });
  }
  return commands;
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  process.chdir(root);
  const action = process.argv[2] ?? "start";
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: ./run.sh [--tunnel] | ./kill.sh | pnpm verify:model");
    console.log("GPU selection is automatic. CPU-only inference is supported when the model fits in system memory.");
    return;
  }
  const endpoint = controlEndpoint(path.resolve(root));
  if (action !== "start" && action !== "stop" && action !== "verify") throw new Error("Usage: launcher.ts start [--tunnel] | stop | verify");
  if (existsSync(".env")) process.loadEnvFile(".env");
  if (action === "stop") {
    const stopped = await stopEverything(root, endpoint);
    console.log(stopped.length > 0 ? `Stopped ${stopped.join(", ")}.` : "No EdgeInference services or port holders are running.");
    return;
  }
  const config = loadConfig();
  const audit = await runEnvironmentAudit();
  if (!audit.passed) throw new Error("Gateway requirements failed: Node.js >= 24 and working better-sqlite3/sharp builds are required. Run pnpm verify:env.");
  const hardware = detectHost();
  console.log(`Gateway: ${hardware.platform}/${hardware.arch}, CPU ${hardware.cpuModel} (${hardware.logicalCpus} logical cores), ${audit.totalMemoryGiB} GiB system RAM`);
  const verifyModels = async (signal?: AbortSignal) => {
    const allocations = await checkModelReadiness(config.ollamaBaseUrl, config.allowedModels, 300_000, signal);
    for (const allocation of allocations) {
      const processor = { cpu: "CPU-only (GPU not required)", gpu: "GPU", mixed: "CPU/GPU", unknown: "backend allocation not reported" }[allocation.executionMode];
      const gpuMemory = allocation.executionMode === "unknown" ? "GPU allocation unavailable" : `${(allocation.vramBytes / 1024 ** 3).toFixed(2)} GiB GPU allocation`;
      console.log(`Ready: ${allocation.model}, ${processor}, ${(allocation.sizeBytes / 1024 ** 3).toFixed(2)} GiB loaded, ${gpuMemory}`);
    }
  };
  if (action === "verify") { await verifyModels(); return; }
  const stopped = await stopEverything(root, endpoint);
  if (stopped.length > 0) console.log(`Stopped before starting: ${stopped.join(", ")}.`);
  const tunnel = process.argv.includes("--tunnel") || process.argv.includes("-t") ||
    [process.env.CLOUDFLARE_TUNNEL_ENABLED, process.env.CF_TUNNEL_ENABLED].includes("true") ||
    Boolean(process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.CF_TUNNEL_TOKEN);
  const nginx = resolveExecutable("nginx", hardware);
  const executables = { nginx, ...(tunnel ? { cloudflared: resolveExecutable("cloudflared", hardware) } : {}) };
  console.log(`Nginx executable: ${nginx}`);
  const commands = createServiceCommands(config, root, tunnel, process.env, executables);
  const backend = await getOllamaService(config.ollamaBaseUrl, hardware, process.env);
  if (backend) {
    const waitForBackend = backend.ready;
    backend.ready = async (signal) => { await waitForBackend?.(signal); await verifyModels(signal); };
    commands.unshift(backend);
    console.log(`Starting local Ollama: ${backend.command}`);
  } else {
    console.log(`Using running Ollama at ${config.ollamaBaseUrl}`);
    await verifyModels();
  }
  await Promise.all(["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].map((name) =>
    mkdir(path.join("data/nginx", name), { recursive: true })));
  await writeFile("data/runtime-nginx.conf", renderNginxConfig(await readFile("infra/nginx/nginx.conf", "utf8"), config));
  console.log("Starting EdgeInference at http://127.0.0.1:8080/v1. Press Ctrl+C to stop.");
  await runServices(commands, endpoint);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
