import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlEndpoint, runServices } from "../../scripts/runtime/service-supervisor.js";
import { isLeftoverProcess, stopRunningServices } from "../../scripts/runtime/service-cleanup.js";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startProcess(script: string, ...args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  return child;
}

function listenOn(port: number, prelude = ""): Promise<ChildProcess> {
  return startProcess(`${prelude}require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`);
}

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

async function cleanupOptions(ports: number[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "edge-cleanup-"));
  directories.push(directory);
  return { endpoint: controlEndpoint(directory), root: directory, ports, proxyPort: ports[0]! };
}

describe.skipIf(process.platform === "win32")("stopping everything EdgeInference needs", () => {
  it("kills an unrelated process holding a service port", async () => {
    const port = await freePort();
    const holder = await listenOn(port);
    const stopped = await stopRunningServices(await cleanupOptions([port]));
    expect(hasExited(holder)).toBe(true);
    expect(stopped.join()).toContain(`PID ${holder.pid}`);
  }, 15000);

  it("kills the holder when only one of the service ports is held", async () => {
    const [heldPort, freeServicePort] = [await freePort(), await freePort()];
    const holder = await listenOn(heldPort);
    await stopRunningServices(await cleanupOptions([heldPort, freeServicePort]));
    expect(hasExited(holder)).toBe(true);
  }, 15000);

  it("force kills a port holder that ignores SIGTERM", async () => {
    const port = await freePort();
    const holder = await listenOn(port, "process.on('SIGTERM', () => {});");
    await stopRunningServices(await cleanupOptions([port]));
    expect(holder.signalCode).toBe("SIGKILL");
  }, 15000);

  it("reports nothing when no service is running", async () => {
    await expect(stopRunningServices(await cleanupOptions([await freePort()]))).resolves.toEqual([]);
  }, 15000);

  it("stops a live supervisor through its control endpoint", async () => {
    const options = await cleanupOptions([await freePort()]);
    const running = runServices([{ name: "idle", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }], options.endpoint);
    for (let i = 0; i < 100 && !(await isListening(options.endpoint)); i++) await new Promise((r) => setTimeout(r, 10));
    await expect(stopRunningServices(options)).resolves.toEqual(["the running EdgeInference supervisor"]);
    await expect(running).resolves.toBeUndefined();
  }, 15000);

  it("still frees ports when a supervisor does not confirm shutdown", async () => {
    const port = await freePort();
    const holder = await listenOn(port);
    const options = await cleanupOptions([port]);
    const unresponsive = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => unresponsive.listen(options.endpoint, resolve));
    try {
      await stopRunningServices(options);
      expect(hasExited(holder)).toBe(true);
    } finally { await new Promise((resolve) => unresponsive.close(resolve)); }
  }, 15000);

  it("fails and names the process when a port holder survives", async () => {
    const port = await freePort();
    const holder = await listenOn(port);
    await expect(stopRunningServices({ ...(await cleanupOptions([port])), signal: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } }))
      .rejects.toThrow(new RegExp(`PID ${holder.pid}`));
    expect(hasExited(holder)).toBe(false);
  }, 15000);
});

function isListening(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

describe("recognizing leftover EdgeInference processes", () => {
  const context = { root: "/project/", proxyPort: 8080, tunnelToken: "configured-token" };

  it("matches this checkout's gateway", () => {
    expect(isLeftoverProcess("/bin/node --import tsx /project/gateway/src/main.ts", context)).toBe(true);
    expect(isLeftoverProcess("/bin/node --import tsx /other/gateway/src/main.ts", context)).toBe(false);
  });

  it("matches quick tunnels to the proxy port and only that port", () => {
    expect(isLeftoverProcess("cloudflared tunnel --url http://127.0.0.1:8080", context)).toBe(true);
    expect(isLeftoverProcess("cloudflared tunnel --url http://127.0.0.1:3000", context)).toBe(false);
  });

  it("matches named tunnels using the configured token and no others", () => {
    expect(isLeftoverProcess("/opt/cloudflared tunnel run --token configured-token", context)).toBe(true);
    expect(isLeftoverProcess("/opt/cloudflared tunnel run --token other-token", context)).toBe(false);
    expect(isLeftoverProcess("/opt/cloudflared tunnel run --token-file /secret/token", context)).toBe(false);
  });

  it("leaves Ollama alone", () => {
    expect(isLeftoverProcess("/Applications/Ollama.app/Contents/Resources/ollama serve", context)).toBe(false);
  });
});
