import { describe, expect, it } from "vitest";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";

describe("API secret configuration", () => {
  it.each([undefined, "", " ", "\t\n"])("rejects a missing or blank primary secret", (secret) => {
    expect(() => loadConfig({ LLM_API_SECRET: secret })).toThrow(/LLM_API_SECRET/);
  });

  it("rejects a blank configured rotation secret", () => {
    expect(() => loadConfig({ LLM_API_SECRET: "configured-secret", LLM_API_SECRET_PREVIOUS: "  " }))
      .toThrow(/LLM_API_SECRET_PREVIOUS/);
  });

  it("allows an empty rotation secret to disable rotation", () => {
    expect(loadConfig({ LLM_API_SECRET: "configured-secret", LLM_API_SECRET_PREVIOUS: "" }).secondaryApiKey).toBe("");
  });
});
