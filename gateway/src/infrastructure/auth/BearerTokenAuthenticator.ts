import crypto from "node:crypto";
import type { ApiKeyAuthenticator, RequestAuthContext } from "../../domain/interfaces/index.js";
import type { AuthenticationResult, ClientRole } from "../../domain/models/types.js";
import { timingSafeEqualString } from "../../domain/utils/timingSafe.js";

export interface ConfiguredKey {
  keyId: string;
  secret: string;
  role?: ClientRole | undefined;
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  key: string
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (Array.isArray(direct)) {
    return direct[0]?.trim();
  }
  return typeof direct === "string" ? direct.trim() : undefined;
}

export class BearerTokenAuthenticator implements ApiKeyAuthenticator {
  private readonly keys: ReadonlyArray<ConfiguredKey>;

  constructor(keys: ConfiguredKey[]) {
    if (!keys || keys.length === 0) {
      throw new Error("BearerTokenAuthenticator requires at least one configured API key.");
    }
    this.keys = Object.freeze([...keys]);
  }

  authenticate(authorizationHeader?: string, context?: RequestAuthContext): AuthenticationResult {
    const headers = context?.headers;
    const credentialHeaderNames = ["authorization", "x-hashed-token", "x-signature", "x-signature-256"];
    const credentialValues = [
      authorizationHeader,
      ...Object.entries(headers ?? {})
        .filter(([name]) => credentialHeaderNames.includes(name.toLowerCase()))
        .flatMap(([, value]) => value ?? [])
    ];
    const submittedCredentials = credentialValues.flatMap((value) =>
      value ? [value, value.trim(), ...value.split(/[,\s]+/)] : []
    );
    for (const credential of submittedCredentials) {
      const rawMatch = credential && this.keys.some((key) => {
        if (timingSafeEqualString(credential, key.secret)) return true;
        const tokenStart = credential.length - key.secret.length;
        return tokenStart > 0
          && /^\s*(?:Bearer|Hashed|HMAC-SHA256)\s+$/i.test(credential.slice(0, tokenStart))
          && timingSafeEqualString(credential.slice(tokenStart), key.secret);
      });
      if (rawMatch) {
        return { authenticated: false, reason: "Raw API secrets are not accepted. Use HMAC-SHA256 or a SHA-256 digest." };
      }
    }

    // -------------------------------------------------------------------------
    // Path 1: Dynamic HMAC-SHA256 Request Signature Verification
    // (Zero raw secret transmission, timestamped, replay-safe)
    // -------------------------------------------------------------------------
    const xSig = getHeaderValue(headers, "x-signature") ?? getHeaderValue(headers, "x-signature-256");
    const xTimestamp = getHeaderValue(headers, "x-timestamp");
    const xKeyId = getHeaderValue(headers, "x-key-id");

    // Also support Authorization: HMAC-SHA256 <sig>
    let hmacAuthSig: string | undefined;
    if (authorizationHeader?.startsWith("HMAC-SHA256 ")) {
      hmacAuthSig = authorizationHeader.slice(12).trim();
    }

    const signatureToVerify = xSig ?? hmacAuthSig;

    if (signatureToVerify) {
      if (!xTimestamp) {
        return {
          authenticated: false,
          reason: "Missing X-Timestamp header required for HMAC-SHA256 signature verification"
        };
      }

      // Parse and validate timestamp freshness (within 300 seconds / 5 minutes)
      let timestampMs: number;
      const numTs = Number(xTimestamp);
      if (!Number.isNaN(numTs) && numTs > 0) {
        // Unix epoch in seconds (10 digits) vs milliseconds (13 digits)
        timestampMs = numTs < 1e11 ? numTs * 1000 : numTs;
      } else {
        timestampMs = Date.parse(xTimestamp);
      }

      if (Number.isNaN(timestampMs)) {
        return { authenticated: false, reason: "Malformed X-Timestamp header" };
      }

      const nowMs = (context?.now ?? new Date()).getTime();
      const driftSeconds = Math.abs(nowMs - timestampMs) / 1000;
      if (driftSeconds > 300) {
        return {
          authenticated: false,
          reason: `Request signature timestamp expired or skewed (${Math.round(driftSeconds)}s drift exceeds 300s tolerance)`
        };
      }

      const method = (context?.method ?? "POST").toUpperCase();
      const path = (context?.url ?? "").split("?")[0] || "";

      // Candidate canonical payloads:
      // Format A (Standard): `${xTimestamp}:${method}:${path}`
      // Format B (Simple): `${xTimestamp}`
      const canonicalCandidates = [
        `${xTimestamp}:${method}:${path}`,
        `${xTimestamp}`
      ];

      // If xKeyId was provided, restrict check to that key
      const keysToCheck = xKeyId ? this.keys.filter((k) => k.keyId === xKeyId) : this.keys;

      for (const key of keysToCheck) {
        for (const candidate of canonicalCandidates) {
          const expectedSig = crypto.createHmac("sha256", key.secret).update(candidate).digest("hex");
          if (timingSafeEqualString(signatureToVerify, expectedSig)) {
            const role = key.role ?? (key.keyId.startsWith("owner") || key.keyId.includes("primary") ? "owner" : "guest");
            return {
              authenticated: true,
              keyId: key.keyId,
              role
            };
          }
        }
      }

      return { authenticated: false, reason: "Invalid HMAC-SHA256 signature" };
    }

    // -------------------------------------------------------------------------
    // Path 2: SHA-256 Pre-Hashed Token Header Verification
    // (Zero raw secret transmission via X-Hashed-Token: <sha256>)
    // -------------------------------------------------------------------------
    const xHashedToken = getHeaderValue(headers, "x-hashed-token");
    if (xHashedToken) {
      for (const key of this.keys) {
        const expectedHash = crypto.createHash("sha256").update(key.secret).digest("hex");
        if (timingSafeEqualString(xHashedToken, expectedHash)) {
          const role = key.role ?? (key.keyId.startsWith("owner") || key.keyId.includes("primary") ? "owner" : "guest");
          return {
            authenticated: true,
            keyId: key.keyId,
            role
          };
        }
      }
      return { authenticated: false, reason: "Invalid X-Hashed-Token" };
    }

    // -------------------------------------------------------------------------
    // Path 3: Authorization Header Verification (Bearer or Hashed)
    // Supports:
    //   - Authorization: Bearer <sha256_hash_of_secret>
    //   - Authorization: Hashed <sha256_hash_of_secret>
    // -------------------------------------------------------------------------
    if (!authorizationHeader || typeof authorizationHeader !== "string") {
      return { authenticated: false, reason: "Missing Authorization header or cryptographic signature" };
    }

    const trimmed = authorizationHeader.trim();
    const parts = trimmed.split(/\s+/);

    if (parts.length !== 2 || (parts[0] !== "Bearer" && parts[0] !== "Hashed")) {
      return {
        authenticated: false,
        reason: "Malformed Authorization header; expected 'Bearer <sha256>', 'Hashed <sha256>', or HMAC headers"
      };
    }

    const submittedToken = parts[1];
    if (!submittedToken) {
      return { authenticated: false, reason: "Empty bearer token" };
    }

    // Compare only SHA-256 digests. Raw API secrets are rejected above.
    for (const key of this.keys) {
      const expectedHash = crypto.createHash("sha256").update(key.secret).digest("hex");
      const isHashMatch = timingSafeEqualString(submittedToken, expectedHash);

      if (isHashMatch) {
        const role = key.role ?? (key.keyId.startsWith("owner") || key.keyId.includes("primary") ? "owner" : "guest");
        return {
          authenticated: true,
          keyId: key.keyId,
          role
        };
      }
    }

    return { authenticated: false, reason: "Invalid SHA-256 token" };
  }
}
