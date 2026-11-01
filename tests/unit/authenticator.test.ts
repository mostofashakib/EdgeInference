import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
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

  describe("Cryptographic Authentication (Zero-Plaintext-Secret)", () => {
    const fixedNow = new Date("2026-11-01T12:00:00.000Z");
    const fixedTimestampSec = Math.floor(fixedNow.getTime() / 1000).toString();

    it("passes authentication with HMAC-SHA256 signature (canonical: timestamp:method:url)", () => {
      const canonical = `${fixedTimestampSec}:POST:/v1/chat/completions`;
      const signature = crypto.createHmac("sha256", primarySecret).update(canonical).digest("hex");

      const result = authenticator.authenticate(undefined, {
        headers: {
          "x-signature": signature,
          "x-timestamp": fixedTimestampSec
        },
        method: "POST",
        url: "/v1/chat/completions",
        now: fixedNow
      });

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.keyId).toBe("key-primary");
        expect(result.role).toBe("owner");
      }
    });

    it("passes authentication with HMAC-SHA256 signature in Authorization header", () => {
      const canonical = `${fixedTimestampSec}:POST:/v1/chat/completions`;
      const signature = crypto.createHmac("sha256", primarySecret).update(canonical).digest("hex");

      const result = authenticator.authenticate(`HMAC-SHA256 ${signature}`, {
        headers: {
          "x-timestamp": fixedTimestampSec
        },
        method: "POST",
        url: "/v1/chat/completions",
        now: fixedNow
      });

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.keyId).toBe("key-primary");
      }
    });

    it("rejects forged or incorrect HMAC-SHA256 signature", () => {
      const forgedSignature = "a".repeat(64);

      const result = authenticator.authenticate(undefined, {
        headers: {
          "x-signature": forgedSignature,
          "x-timestamp": fixedTimestampSec
        },
        method: "POST",
        url: "/v1/chat/completions",
        now: fixedNow
      });

      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.reason).toContain("Invalid HMAC-SHA256 signature");
      }
    });

    it("rejects HMAC signature when timestamp is expired (> 300s drift)", () => {
      const expiredTimestampSec = (Math.floor(fixedNow.getTime() / 1000) - 301).toString();
      const canonical = `${expiredTimestampSec}:POST:/v1/chat/completions`;
      const signature = crypto.createHmac("sha256", primarySecret).update(canonical).digest("hex");

      const result = authenticator.authenticate(undefined, {
        headers: {
          "x-signature": signature,
          "x-timestamp": expiredTimestampSec
        },
        method: "POST",
        url: "/v1/chat/completions",
        now: fixedNow
      });

      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.reason).toContain("expired or skewed");
      }
    });

    it("rejects HMAC signature when timestamp header is missing", () => {
      const signature = crypto.createHmac("sha256", primarySecret).update("payload").digest("hex");

      const result = authenticator.authenticate(undefined, {
        headers: {
          "x-signature": signature
        },
        now: fixedNow
      });

      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.reason).toContain("Missing X-Timestamp");
      }
    });

    it("passes authentication with pre-hashed SHA-256 token (Authorization: Bearer <sha256>)", () => {
      const sha256Hash = crypto.createHash("sha256").update(primarySecret).digest("hex");

      const result = authenticator.authenticate(`Bearer ${sha256Hash}`);

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.keyId).toBe("key-primary");
        expect(result.role).toBe("owner");
      }
    });

    it("passes authentication with pre-hashed SHA-256 token (Authorization: Hashed <sha256>)", () => {
      const sha256Hash = crypto.createHash("sha256").update(primarySecret).digest("hex");

      const result = authenticator.authenticate(`Hashed ${sha256Hash}`);

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.keyId).toBe("key-primary");
      }
    });

    it("passes authentication with pre-hashed SHA-256 token via X-Hashed-Token header", () => {
      const sha256Hash = crypto.createHash("sha256").update(primarySecret).digest("hex");

      const result = authenticator.authenticate(undefined, {
        headers: {
          "x-hashed-token": sha256Hash
        }
      });

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.keyId).toBe("key-primary");
      }
    });

    it("rejects invalid pre-hashed token", () => {
      const invalidHash = crypto.createHash("sha256").update("wrong-secret").digest("hex");

      const result = authenticator.authenticate(`Bearer ${invalidHash}`);

      expect(result.authenticated).toBe(false);
    });

    it("identifies guest role when guest key is hashed", () => {
      const guestSecret = "guest_secret_value_1234567890abcdef1234567890abcdef";
      const guestAuth = new BearerTokenAuthenticator([
        { keyId: "owner-primary", secret: primarySecret, role: "owner" },
        { keyId: "guest-app-1", secret: guestSecret, role: "guest" }
      ]);

      const guestHash = crypto.createHash("sha256").update(guestSecret).digest("hex");
      const result = guestAuth.authenticate(`Bearer ${guestHash}`);

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.keyId).toBe("guest-app-1");
        expect(result.role).toBe("guest");
      }
    });
  });
});

