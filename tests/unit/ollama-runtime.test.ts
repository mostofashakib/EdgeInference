import { afterEach, describe, expect, it, vi } from "vitest";
import { getOllamaService } from "../../scripts/runtime/ollama-runtime.js";

const host = { platform: "darwin" as const, arch: "arm64" };
const refused = () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
afterEach(() => vi.unstubAllGlobals());

describe("automatic local backend startup", () => {
  it("reuses a running Ollama without requiring a local executable", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ version: "1.0" }));
    expect(await getOllamaService("http://127.0.0.1:11434", host, { OLLAMA_BIN: "/missing" })).toBeUndefined();
  });

  it("starts a stopped local backend on its configured port with inherited GPU settings", async () => {
    vi.stubGlobal("fetch", refused);
    const service = await getOllamaService("http://127.0.0.1:11435", host, { OLLAMA_BIN: process.execPath, CUDA_VISIBLE_DEVICES: "0" });
    expect(service?.command).toBe(process.execPath);
    expect(service?.args).toEqual(["serve"]);
    expect(service?.env?.OLLAMA_HOST).toBe("127.0.0.1:11435");
    expect(service?.env?.CUDA_VISIBLE_DEVICES).toBe("0");
  });

  it("never starts a local process to replace an unreachable remote backend", async () => {
    vi.stubGlobal("fetch", refused);
    await expect(getOllamaService("http://remote:11434", host, {})).rejects.toThrow(/remote/);
  });

  it("does not start another process when the backend returns HTTP errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await expect(getOllamaService("http://127.0.0.1:11434", host, {})).rejects.toThrow(/503/);
  });

  it("does not spawn on a timeout that leaves backend ownership uncertain", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("timed out"); });
    await expect(getOllamaService("http://127.0.0.1:11434", host, {})).rejects.toThrow(/timed out/);
  });

  it("rejects a non-Ollama service at the endpoint", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ service: "other" }));
    await expect(getOllamaService("http://127.0.0.1:11434", host, {})).rejects.toThrow(/Ollama/);
  });
});
