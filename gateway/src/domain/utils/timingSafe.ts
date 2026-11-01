import crypto from "node:crypto";

/**
 * Compares two strings in constant time to prevent timing attacks.
 * Both strings are hashed with SHA-256 to ensure fixed-length buffers
 * before invoking crypto.timingSafeEqual.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

