import { describe, it, expect } from "vitest";
import { BearerTokenAuthenticator } from "../../gateway/src/infrastructure/auth/BearerTokenAuthenticator.js";

describe("BearerTokenAuthenticator", () => {
  const primarySecret = "a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef";
  const secondarySecret = "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

  const authenticator = new BearerTokenAuthenticator([
    { keyId: "key-primary", secret: primarySecret },
    { keyId: "key-secondary", secret: secondarySecret }
  ]);

  it("passes authentication with valid primary secret", () => {
    // Arrange & Act
    const result = authenticator.authenticate(`Bearer ${primarySecret}`);

    // Assert
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.keyId).toBe("key-primary");
    }
  });

  it("passes authentication with valid secondary rotated secret", () => {
    // Arrange & Act
    const result = authenticator.authenticate(`Bearer ${secondarySecret}`);

    // Assert
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.keyId).toBe("key-secondary");
    }
  });

  it("rejects when Authorization header is missing", () => {
    // Arrange & Act
    const result = authenticator.authenticate(undefined);

    // Assert
    expect(result.authenticated).toBe(false);
  });

  it("rejects when Authorization header is empty string", () => {
    // Arrange & Act
    const result = authenticator.authenticate("");

    // Assert
    expect(result.authenticated).toBe(false);
  });

  it("rejects when token is empty (Bearer only)", () => {
    // Arrange & Act
    const result = authenticator.authenticate("Bearer ");

    // Assert
    expect(result.authenticated).toBe(false);
  });

  it("rejects when scheme is not Bearer", () => {
    // Arrange & Act
    const result = authenticator.authenticate(`Basic ${primarySecret}`);

    // Assert
    expect(result.authenticated).toBe(false);
  });

  it("rejects when bearer token is invalid", () => {
    // Arrange & Act
    const result = authenticator.authenticate(`Bearer invalid_secret_token_12345`);

    // Assert
    expect(result.authenticated).toBe(false);
  });

  it("rejects when token has multiple spaces or extra segments", () => {
    // Arrange & Act
    const result = authenticator.authenticate(`Bearer ${primarySecret} extra_token`);

    // Assert
    expect(result.authenticated).toBe(false);
  });

  it("rejects revoked secrets", () => {
    // Arrange: an authenticator without the secondary secret
    const strictAuth = new BearerTokenAuthenticator([
      { keyId: "key-primary", secret: primarySecret }
    ]);

    // Act
    const result = strictAuth.authenticate(`Bearer ${secondarySecret}`);

    // Assert
    expect(result.authenticated).toBe(false);
  });
});

