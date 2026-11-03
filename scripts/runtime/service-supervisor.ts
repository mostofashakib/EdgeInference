import { promisify } from "node:util";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface ServiceCommand {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  ready?: (signal: AbortSignal) => Promise<void>;
  shutdown?: () => Promise<void>;
}

export function controlEndpoint(root: string, platform: NodeJS.Platform = process.platform): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 20);
  return platform === "win32" ? `\\\\.\\pipe\\edgeinference-${id}` : path.join(os.tmpdir(), `edgeinference-${id}.sock`);
}

export function stopServices(endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let acknowledgement = "";
    socket.setTimeout(15000, () => socket.destroy(new Error("Supervisor stop timed out")));
    socket.once("connect", () => socket.write("stop\n"));
    socket.on("data", (data) => { acknowledgement += data.toString(); });
    socket.once("error", reject);
    socket.once("close", () => {
      if (acknowledgement.trim() === "stopped") resolve();
      else reject(new Error("Supervisor did not confirm shutdown"));
    });
  });
}

export async function terminateManagedProcess(child: ChildProcess, graceful = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve, reject) => {
    // Nginx's stop command signals the master asynchronously on Windows.
    // Give it time to reap workers before using a process-tree fallback.
    const forceTerminate = () => {
      if (process.platform === "win32") {
        void promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000 })
          .catch((error: Error) => {
            if (child.exitCode === null && child.signalCode === null) reject(error);
          });
      } else {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(forceTerminate, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    if (!graceful) {
      if (process.platform === "win32") forceTerminate();
      else child.kill("SIGTERM");
    }
  });
}

export async function runServices(commands: readonly ServiceCommand[], endpoint: string): Promise<void> {
  const children: Array<{ child: ChildProcess; service: ServiceCommand }> = [];
  const controller = new AbortController();
  let finish!: (error?: Error) => void;
  const lifetime = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (controller.signal.aborted) return;
      controller.abort();
      if (error) reject(error); else resolve();
    };
  });
  // A child might fail while another service is awaiting readiness.
  void lifetime.catch(() => {});
  const stopRequests = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let command = "";
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("data", (data) => {
      command += data.toString();
      if (command.length > 64) { socket.destroy(); return; }
      if (!command.includes("\n")) return;
      if (command.trim() !== "stop") { socket.end("invalid command\n"); return; }
      socket.setTimeout(15000, () => socket.destroy());
      stopRequests.add(socket);
      finish();
    });
    socket.on("close", () => stopRequests.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  const onSignal = () => finish();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    for (const service of commands) {
      if (controller.signal.aborted) break;
      const child = spawn(service.command, service.args, { stdio: "inherit", shell: false, env: service.env ?? process.env });
      children.push({ child, service });
      child.once("error", (error) => finish(new Error(`${service.name} failed to start: ${error.message}`)));
      child.once("exit", (code, signal) => finish(new Error(`${service.name} exited unexpectedly (${code ?? signal})`)));
      if (service.ready) await service.ready(controller.signal);
    }
    await lifetime;
  } catch (error) {
    finish(error as Error);
    // Stop requests during startup abort readiness without turning shutdown into failure.
    await lifetime;
  } finally {
    controller.abort();
    await Promise.all(children.reverse().map(async ({ child, service }) => {
      if (child.pid && child.exitCode === null && child.signalCode === null && service.shutdown) {
        try { await service.shutdown(); } catch (error) { console.error(`${service.name} shutdown failed:`, error); }
      }
      await terminateManagedProcess(child, Boolean(service.shutdown));
    }));
    for (const socket of stopRequests) socket.end("stopped\n");
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
