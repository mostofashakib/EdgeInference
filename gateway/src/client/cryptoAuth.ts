import crypto from "node:crypto";

export interface HmacSignatureOptions {
  secret: string;
  method?: string | undefined;
  path?: string | undefined;
  keyId?: string | undefined;
  timestamp?: string | number | undefined;
}

/**
 * Generates cryptographic HMAC-SHA256 headers for zero-plaintext-secret transmission.
 * The raw secret never leaves the client application.
 */
export function createHmacAuthHeaders(options: HmacSignatureOptions): Record<string, string> {
  const method = (options.method ?? "POST").toUpperCase();
  const path = (options.path ?? "/v1/chat/completions").split("?")[0] || "/";
  const timestamp = options.timestamp
    ? String(options.timestamp)
    : Math.floor(Date.now() / 1000).toString();

  // Canonical string: ${timestamp}:${method}:${path}
  const canonicalPayload = `${timestamp}:${method}:${path}`;
  const signature = crypto
    .createHmac("sha256", options.secret)
    .update(canonicalPayload)
    .digest("hex");

  const headers: Record<string, string> = {
    "X-Signature": signature,
    "X-Timestamp": timestamp
  };

  if (options.keyId) {
    headers["X-Key-Id"] = options.keyId;
  }

  return headers;
}

/**
 * Pre-hashes the secret using SHA-256 for clients that cannot use dynamic timestamps.
 * The raw secret is never transmitted across the network.
 */
export function hashSecretSha256(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/**
 * Returns Authorization header with pre-hashed SHA-256 token.
 */
export function createHashedBearerHeader(secret: string): { Authorization: string } {
  return {
    Authorization: `Bearer ${hashSecretSha256(secret)}`
  };
}

