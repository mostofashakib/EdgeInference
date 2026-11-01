import type { AccessValidator } from "../../domain/interfaces/index.js";
import { timingSafeEqualString } from "../../domain/utils/timingSafe.js";

export interface CloudflareServiceToken {
  clientId: string;
  clientSecret: string;
}

export interface CloudflareAccessValidatorOptions {
  enabled: boolean;
  serviceTokens?: CloudflareServiceToken[] | undefined;
  teamDomain?: string | undefined;
  aud?: string | undefined;
}

export class CloudflareAccessValidator implements AccessValidator {
  private readonly enabled: boolean;
  private readonly tokens: ReadonlyArray<CloudflareServiceToken>;

  constructor(options: CloudflareAccessValidatorOptions) {
    this.enabled = options.enabled;
    this.tokens = Object.freeze([...(options.serviceTokens ?? [])]);
  }

  validate(headers: Record<string, string | string[] | undefined>): {
    valid: boolean;
    reason?: string | undefined;
  } {
    if (!this.enabled) {
      return { valid: true };
    }

    const clientIdRaw = headers["cf-access-client-id"];
    const clientSecretRaw = headers["cf-access-client-secret"];

    const clientId = Array.isArray(clientIdRaw) ? clientIdRaw[0] : clientIdRaw;
    const clientSecret = Array.isArray(clientSecretRaw) ? clientSecretRaw[0] : clientSecretRaw;

    if (!clientId || !clientSecret) {
      return {
        valid: false,
        reason: "Missing Cloudflare Access credentials ('cf-access-client-id' / 'cf-access-client-secret')"
      };
    }

    // Check service tokens using constant-time comparison
    for (const token of this.tokens) {
      const idMatch = timingSafeEqualString(clientId, token.clientId);
      const secretMatch = timingSafeEqualString(clientSecret, token.clientSecret);

      if (idMatch && secretMatch) {
        return { valid: true };
      }
    }

    return {
      valid: false,
      reason: "Invalid or revoked Cloudflare Access service token"
    };
  }
}
