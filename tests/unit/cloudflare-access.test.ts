import { describe, it, expect } from "vitest";
import { CloudflareAccessValidator } from "../../gateway/src/infrastructure/auth/CloudflareAccessValidator.js";

describe("CloudflareAccessValidator", () => {
  const validClientId = "cf-client-id-abc123xyz";
  const validClientSecret = "cf-client-secret-9876543210abcdef9876543210abcdef";

  const validator = new CloudflareAccessValidator({
    enabled: true,
    serviceTokens: [
      { clientId: validClientId, clientSecret: validClientSecret }
    ]
  });

  it("passes when valid Cloudflare service headers are supplied", () => {
    const result = validator.validate({
      "cf-access-client-id": validClientId,
      "cf-access-client-secret": validClientSecret
    });

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when Cloudflare headers are missing", () => {
    const result = validator.validate({});
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("fails when Client ID is incorrect", () => {
    const result = validator.validate({
      "cf-access-client-id": "wrong-id",
      "cf-access-client-secret": validClientSecret
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid/i);
  });

  it("fails when Client Secret is incorrect", () => {
    const result = validator.validate({
      "cf-access-client-id": validClientId,
      "cf-access-client-secret": "wrong-secret"
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid/i);
  });

  it("fails when token is revoked (not in configured list)", () => {
    const strictValidator = new CloudflareAccessValidator({
      enabled: true,
      serviceTokens: []
    });

    const result = strictValidator.validate({
      "cf-access-client-id": validClientId,
      "cf-access-client-secret": validClientSecret
    });

    expect(result.valid).toBe(false);
  });

  it("always passes when validator is disabled (e.g. pure local dev without Cloudflare)", () => {
    const disabledValidator = new CloudflareAccessValidator({
      enabled: false
    });

    const result = disabledValidator.validate({});
    expect(result.valid).toBe(true);
  });
});

