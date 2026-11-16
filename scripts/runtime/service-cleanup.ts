import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { stopServices } from "./service-supervisor.js";

const run = promisify(execFile);
const TERMINATE_GRACE_MS = 5000;
const KILL_GRACE_MS = 1000;

export interface LeftoverContext {
  root: string;
  proxyPort: number;
  tunnelToken?: string | undefined;
}

export interface CleanupOptions extends LeftoverContext {
  endpoint: string;
  ports: readonly number[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

export function isLeftoverProcess(command: string, { root, proxyPort, tunnelToken }: LeftoverContext): boolean {
  if (command.includes(` ${path.join(root, "gateway/src/main.ts")}`)) return true;
  if (command.includes(` ${path.join(root, "scripts/runtime/launcher.ts")}`)) return true;
  const parts = command.trim().split(/\s+/);
  if (path.basename(parts[0] ?? "") !== "cloudflared") return false;
  const flagValue = (flag: string) => {
    const index = parts.indexOf(flag);
    return index < 0 ? undefined : parts[index + 1];
  };
  return flagValue("--url") === `http://127.0.0.1:${proxyPort}`
    || (Boolean(tunnelToken) && flagValue("--token") === tunnelToken);
}

async function stopSupervisor(endpoint: string): Promise<boolean> {
  try {
    await stopServices(endpoint);
    return true;
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      console.warn(`Continuing cleanup: ${(error as Error).message}`);
    }
    return false;
  }
}

const parsePids = (output: string) => output.split("\n").filter(Boolean).map(Number);

async function findPortHolders(ports: readonly number[]): Promise<number[]> {
  try {
    const { stdout } = await run("lsof", ["-nP", "-t", ...ports.map((port) => `-iTCP:${port}`), "-sTCP:LISTEN"]);
    return parsePids(stdout);
  } catch (error) {
    const { code, stdout } = error as { code?: number | string; stdout?: string };
    // lsof exits 1 when any requested port has no holder, even if it found the others.
    if (code === 1) return parsePids(stdout ?? "");
    if (code === "ENOENT") throw new Error("Freeing service ports requires lsof. Install it and try again.", { cause: error });
    throw error;
  }
}

async function findSocketHolders(endpoint: string): Promise<number[]> {
  if (process.platform === "win32" || !existsSync(endpoint)) return [];
  try {
    const { stdout } = await run("lsof", ["-nP", "-t", endpoint]);
    return parsePids(stdout);
  } catch (error) {
    const { code, stdout } = error as { code?: number | string; stdout?: string };
    if (code === 1) return parsePids(stdout ?? "");
    return [];
  }
}

async function getProcessCwd(pid: number): Promise<string | undefined> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      for (const line of stdout.split("\n")) {
        if (line.startsWith("n")) return line.slice(1);
      }
    } catch {
      return undefined;
    }
  } else if (process.platform === "linux") {
    try {
      const { readlink } = await import("node:fs/promises");
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function findLeftovers(context: LeftoverContext): Promise<number[]> {
  const { stdout } = await run("ps", ["-axww", "-o", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 });
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]!;
    if (isLeftoverProcess(command, context)) {
      pids.push(pid);
    } else if (
      command.includes("scripts/runtime/launcher.ts") ||
      command.includes("scripts/runtime/launcher.js")
    ) {
      const cwd = await getProcessCwd(pid);
      if (cwd && path.resolve(cwd) === path.resolve(context.root)) {
        pids.push(pid);
      }
    }
  }
  return pids;
}

async function findTargets(options: CleanupOptions): Promise<number[]> {
  const [holders, socketHolders, leftovers] = await Promise.all([
    findPortHolders(options.ports),
    findSocketHolders(options.endpoint),
    findLeftovers(options)
  ]);
  return [...new Set([...holders, ...socketHolders, ...leftovers])].filter((pid) => pid !== process.pid);
}

// Commands can contain tunnel tokens, so reports only use the executable name.
async function describeProcesses(pids: readonly number[]): Promise<string[]> {
  const { stdout } = await run("ps", ["-ww", "-o", "pid=,comm=", "-p", pids.join(",")]).catch(() => ({ stdout: "" }));
  const names = new Map(stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [[Number(match[1]), path.basename(match[2]!)] as const] : [];
  }));
  return pids.map((pid) => `PID ${pid} (${names.get(pid) ?? "unknown"})`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive) && Date.now() < deadline) await delay(50);
}

function sendToAll(pids: readonly number[], signalName: NodeJS.Signals, signal: NonNullable<CleanupOptions["signal"]>): void {
  for (const pid of pids) {
    try {
      signal(pid, signalName);
    } catch (error) {
      // Exited processes need no signal. Denied ones fail the recheck with a named PID.
      if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

export async function stopRunningServices(options: CleanupOptions): Promise<string[]> {
  const stopped = (await stopSupervisor(options.endpoint)) ? ["the running EdgeInference supervisor"] : [];
  if (process.platform === "win32") return stopped;
  const targets = await findTargets(options);
  if (targets.length === 0) {
    if (existsSync(options.endpoint)) {
      await rm(options.endpoint, { force: true }).catch(() => {});
    }
    return stopped;
  }
  const descriptions = await describeProcesses(targets);
  const signal = options.signal ?? ((pid, signalName) => { process.kill(pid, signalName); });
  sendToAll(targets, "SIGTERM", signal);
  sendToAll(targets, "SIGCONT", signal);
  await waitForExit(targets, TERMINATE_GRACE_MS);
  sendToAll(targets.filter(isAlive), "SIGKILL", signal);
  sendToAll(targets.filter(isAlive), "SIGCONT", signal);
  await waitForExit(targets, KILL_GRACE_MS);
  const survivors = await findTargets(options);
  if (survivors.length > 0) {
    throw new Error(`Could not stop ${(await describeProcesses(survivors)).join(", ")}. It needs more privileges, or a service manager restarted it.`);
  }
  if (existsSync(options.endpoint)) {
    await rm(options.endpoint, { force: true }).catch(() => {});
  }
  return [...stopped, ...descriptions];
}
