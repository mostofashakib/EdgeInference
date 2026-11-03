import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import Database from "better-sqlite3";
import { runEnvironmentAudit } from "../../scripts/verify/audit-environment.js";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";

afterEach(() => vi.restoreAllMocks());

describe("portable gateway requirements", () => {
  it("accepts an x64 gateway with 4 GiB instead of requiring unified memory", async () => {
    new Database(":memory:").close();
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
    expect((await runEnvironmentAudit()).passed).toBe(true);
  });

  it("uses LLM_MODEL as the default allowlist when selecting a smaller model", () => {
    expect(loadConfig({ LLM_API_SECRET: "secret", LLM_MODEL: "small:latest" }).allowedModels)
      .toEqual(["small:latest"]);
  });

  it.each(["", " ", "small,,large"])("rejects an empty model in ALLOWED_MODELS: %s", (models) => {
    expect(() => loadConfig({ LLM_API_SECRET: "secret", ALLOWED_MODELS: models })).toThrow();
  });
});
