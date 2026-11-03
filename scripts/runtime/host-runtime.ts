import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostPlatform {
  platform: NodeJS.Platform;
  arch: string;
}

export interface HostHardware extends HostPlatform {
  cpuModel: string;
  logicalCpus: number;
  totalMemoryBytes: number;
}

export type RuntimeTool = "nginx" | "ollama" | "cloudflared";

export function detectHost(): HostHardware {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem()
  };
}

export function executableCandidates(tool: RuntimeTool, host: HostPlatform, env: NodeJS.ProcessEnv): string[] {
  const windows = host.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const filename = windows ? `${tool}.exe` : tool;
  const searchPath = Object.entries(env).find(([key]) => windows ? key.toUpperCase() === "PATH" : key === "PATH")?.[1];
  const directories = (searchPath ?? "").split(windows ? ";" : ":").filter(Boolean).map((entry) => entry.replace(/^"|"$/g, ""));
  if (host.platform === "darwin") {
    const brew = host.arch === "arm64" ? ["/opt/homebrew", "/usr/local"] : ["/usr/local", "/opt/homebrew"];
    directories.push(...brew.flatMap((prefix) => [`${prefix}/bin`, `${prefix}/sbin`]));
    if (tool === "ollama") directories.push("/Applications/Ollama.app/Contents/Resources");
  } else if (host.platform === "linux") {
    directories.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin");
  } else if (windows) {
    if (tool === "ollama" && env.LOCALAPPDATA) directories.push(paths.join(env.LOCALAPPDATA, "Programs", "Ollama"));
    if (env.ProgramFiles) directories.push(paths.join(env.ProgramFiles, tool));
  }
  return [...new Set(directories.map((directory) => paths.join(directory, filename)))];
}

export function resolveExecutable(tool: RuntimeTool, host: HostPlatform = detectHost(), env: NodeJS.ProcessEnv = process.env): string {
  const variable = `${tool.toUpperCase()}_BIN`;
  const configured = env[variable];
  const candidates = configured ? [configured] : executableCandidates(tool, host, env);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, host.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // Continue searching known install locations for an executable file.
    }
  }
  throw new Error(configured
    ? `${variable} does not point to an executable file: ${configured}`
    : `${tool} was not found for ${host.platform}/${host.arch}. Install it, add its directory to PATH, or set ${variable} in .env.`);
}
