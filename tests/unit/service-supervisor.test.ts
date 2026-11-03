import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runServices, stopServices, controlEndpoint } from "../../scripts/runtime/service-supervisor.js";

async function waitForStop(endpoint: string) {
  for (let i = 0; i < 100; i++) {
    try { await stopServices(endpoint); return; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  throw new Error("Supervisor did not start");
}

describe("portable process supervision", () => {
  it("selects a Windows named pipe or Unix socket without shell commands", () => {
    expect(controlEndpoint("/project", "win32")).toMatch(/^\\\\\.\\pipe\\edgeinference-/);
    expect(controlEndpoint("/project", "linux")).toMatch(/edgeinference-.*\.sock$/);
    expect(controlEndpoint("/other", "linux")).not.toBe(controlEndpoint("/project", "linux"));
  });

  it("stops its child through the control endpoint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "edge-supervisor-"));
    const endpoint = controlEndpoint(directory);
    try {
      const running = runServices([{ name: "test", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }], endpoint);
      await waitForStop(endpoint);
      await expect(running).resolves.toBeUndefined();
      await expect(stopServices(endpoint)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails startup when an executable is missing", async () => {
    const endpoint = controlEndpoint(`missing-${process.pid}`);
    await expect(runServices([{ name: "missing", command: "edge-nonexistent-binary", args: [] }], endpoint))
      .rejects.toThrow(/missing/);
    await expect(stopServices(endpoint)).rejects.toThrow();
  });

  it("fails when a managed process exits unexpectedly", async () => {
    await expect(runServices([{ name: "failed", command: process.execPath, args: ["-e", "process.exit(3)"] }], controlEndpoint(`failed-${process.pid}`)))
      .rejects.toThrow(/failed.*3/);
  });

  it("cleans up when readiness fails", async () => {
    await expect(runServices([{
      name: "unready", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      ready: async () => { throw new Error("not healthy"); }
    }], controlEndpoint(`unready-${process.pid}`))).rejects.toThrow("not healthy");
  });
});

it("runs service shutdown before terminating its child", async () => {
  let shutdown = false;
  const endpoint = controlEndpoint(`shutdown-${process.pid}`);
  const running = runServices([{
    name: "graceful", command: process.execPath, args: ["-e", "setTimeout(() => {}, 100)"],
    shutdown: async () => { shutdown = true; }
  }], endpoint);
  await waitForStop(endpoint);
  await running;
  expect(shutdown).toBe(true);
});

it("allows a service to complete asynchronous graceful shutdown before killing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "edge-graceful-"));
  const marker = path.join(directory, "clean.txt");
  const endpoint = controlEndpoint(directory);
  try {
    const running = runServices([{
      name: "async-shutdown", command: process.execPath,
      args: ["-e", `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'clean'); }, 400)`],
      shutdown: async () => {}
    }], endpoint);
    await waitForStop(endpoint);
    await running;
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(marker, "utf8")).toBe("clean");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("passes the selected backend environment to its managed process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "edge-env-"));
  const marker = path.join(directory, "host.txt");
  try {
    await expect(runServices([{
      name: "env", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.OLLAMA_HOST ?? 'missing')`],
      env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11435" }
    }], controlEndpoint(directory))).rejects.toThrow(/env exited unexpectedly/);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(marker, "utf8")).toBe("127.0.0.1:11435");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("acknowledges stop only after managed processes finish shutting down", async () => {
  let cleanedUp = false;
  const endpoint = controlEndpoint(`stop-ack-${process.pid}`);
  const running = runServices([{
    name: "slow-shutdown", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    shutdown: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); cleanedUp = true; }
  }], endpoint);
  try {
    await waitForStop(endpoint);
    expect(cleanedUp).toBe(true);
  } finally { await running; }
}, 10000);
