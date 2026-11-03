import { afterEach, describe, expect, it, vi } from "vitest";
import { checkModelReadiness } from "../../scripts/verify/model-readiness.js";

afterEach(() => vi.unstubAllGlobals());

describe("model requirements on the Ollama host", () => {
  it.each([0, 500, 1000])("accepts loaded CPU, mixed, and GPU models (VRAM %s)", async (vram) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/ps")) return Response.json({ models: [{ name: "small:latest", size: 1000, size_vram: vram }] });
      return Response.json({ done: true });
    }));
    const result = await checkModelReadiness("http://remote:11435/", ["small:latest"]);
    expect(result).toEqual([{ model: "small:latest", sizeBytes: 1000, vramBytes: vram, executionMode: vram === 0 ? "cpu" : vram < 1000 ? "mixed" : "gpu" }]);
  });

  it("checks every allowed model on the configured remote endpoint", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith("/api/ps") ? Response.json({ models: [{ name: "a:latest", size: 1 }, { name: "b:latest", size: 2 }] }) : Response.json({ done: true });
    });
    expect(await checkModelReadiness("http://remote:11435", ["a:latest", "b:latest"])).toHaveLength(2);
    expect(requests.filter((r) => r.url.endsWith("/api/generate")).map((r) => r.body)).toEqual([
      { model: "a:latest", stream: false }, { model: "b:latest", stream: false }
    ]);
  });

  it.each([
    [404, "model not found"],
    [500, "model requires more system memory"],
    [503, "backend unavailable"]
  ])("reports backend load failure %s with the model and cause", async (status, message) => {
    vi.stubGlobal("fetch", async () => new Response(message, { status }));
    await expect(checkModelReadiness("http://remote:11434", ["large:latest"]))
      .rejects.toThrow(new RegExp(`large:latest.*${message}`));
  });

  it("rejects an incomplete load response", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(checkModelReadiness("http://remote", ["small:latest"]))
      .rejects.toThrow(/small:latest.*load/i);
  });

  it("reports an unloaded model instead of assuming memory allocation", async () => {
    vi.stubGlobal("fetch", async (url: string) => Response.json(url.endsWith("/api/ps") ? { models: [] } : { done: true }));
    await expect(checkModelReadiness("http://remote", ["small:latest"]))
      .rejects.toThrow(/small:latest.*loaded/i);
  });

  it("reports a backend timeout with model context", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
      });
    });
    await expect(checkModelReadiness("http://remote", ["small:latest"], 10))
      .rejects.toThrow(/small:latest.*timed out/i);
  });
});

it("cancels model readiness when the managed backend is stopped", async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return Response.json(url.endsWith("/api/ps") ? { models: [{ name: "small:latest", size: 1 }] } : { done: true });
  });
  await expect(checkModelReadiness("http://remote", ["small:latest"], 300_000, controller.signal)).rejects.toThrow(/abort/i);
});

it("does not claim CPU-only execution when an older backend omits GPU allocation", async () => {
  vi.stubGlobal("fetch", async (url: string) => Response.json(url.endsWith("/api/ps")
    ? { models: [{ name: "small:latest", size: 1000 }] } : { done: true }));
  const allocations = await checkModelReadiness("http://remote", ["small:latest"]);
  expect(allocations[0]?.executionMode).toBe("unknown");
});
