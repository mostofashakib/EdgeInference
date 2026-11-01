import type { ApiKeyAuthenticator } from "../../domain/interfaces/index.js";
import type { AuthenticationResult, ClientRole } from "../../domain/models/types.js";
import { timingSafeEqualString } from "../../domain/utils/timingSafe.js";

export interface ConfiguredKey {
  keyId: string;
  secret: string;
  role?: ClientRole | undefined;
}

export class BearerTokenAuthenticator implements ApiKeyAuthenticator {
  private readonly keys: ReadonlyArray<ConfiguredKey>;

  constructor(keys: ConfiguredKey[]) {
    if (!keys || keys.length === 0) {
      throw new Error("BearerTokenAuthenticator requires at least one configured API key.");
    }
    this.keys = Object.freeze([...keys]);
  }

  authenticate(authorizationHeader?: string): AuthenticationResult {
    if (!authorizationHeader || typeof authorizationHeader !== "string") {
      return { authenticated: false, reason: "Missing Authorization header" };
    }

    const trimmed = authorizationHeader.trim();
    const parts = trimmed.split(/\s+/);

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return { authenticated: false, reason: "Malformed Authorization header; expected 'Bearer <token>'" };
    }

    const submittedToken = parts[1];
    if (!submittedToken) {
      return { authenticated: false, reason: "Empty bearer token" };
    }

    // Check all keys using constant-time string comparison
    for (const key of this.keys) {
      if (timingSafeEqualString(submittedToken, key.secret)) {
        const role = key.role ?? (key.keyId.startsWith("owner") || key.keyId.includes("primary") ? "owner" : "guest");
        return {
          authenticated: true,
          keyId: key.keyId,
          role
        };
      }
    }

    return { authenticated: false, reason: "Invalid API secret" };
  }
}

