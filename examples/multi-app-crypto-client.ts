/**
 * Multi-Application Cryptographic Client Example
 *
 * Demonstrates how external applications connect to the EdgeInference service
 * with zero raw secret transmission across the network.
 *
 * Supported Cryptographic Methods:
 *   1. Dynamic HMAC-SHA256 Request Signing (Replay-safe, recommended)
 *   2. Pre-Hashed SHA-256 Token (Compatible with Bearer header)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 1. Load local environment
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const ENDPOINT_URL = process.env.ENDPOINT_URL || "http://127.0.0.1:8080";
const SECRET = process.env.LLM_API_SECRET || "";
const MODEL = process.env.LLM_MODEL || "qwen3.8:27b";

if (!SECRET) {
  console.error("Error: LLM_API_SECRET is required in .env");
  process.exit(1);
}

// =========================================================================
// METHOD 1: Dynamic HMAC-SHA256 Request Signing (Recommended & Replay-Safe)
// =========================================================================
export function createHmacHeaders(secret: string, method: string, path: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonicalPayload = `${timestamp}:${method.toUpperCase()}:${path}`;
  const signature = crypto.createHmac("sha256", secret).update(canonicalPayload).digest("hex");

  return {
    "X-Signature": signature,
    "X-Timestamp": timestamp
  };
}

async function runHmacSignedRequest(): Promise<void> {
  console.log("\n--- Method 1: HMAC-SHA256 Signed Request (Zero Raw Secret Sent) ---");

  const path = "/v1/chat/completions";
  const hmacHeaders = createHmacHeaders(SECRET, "POST", path);

  const res = await fetch(`${ENDPOINT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...hmacHeaders
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Explain cryptographic message authentication codes in one sentence." }],
      max_tokens: 60
    })
  });

  if (!res.ok) {
    throw new Error(`HMAC request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  console.log("Success! Response from model:");
  console.log(data.choices[0]?.message.content.trim());
}

// =========================================================================
// METHOD 2: Pre-Hashed SHA-256 Token (Static Hash, Zero Raw Secret Sent)
// =========================================================================
export function createHashedBearerHeader(secret: string): { Authorization: string } {
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  return {
    Authorization: `Bearer ${hash}`
  };
}

async function runHashedTokenRequest(): Promise<void> {
  console.log("\n--- Method 2: Pre-Hashed SHA-256 Token (Raw Secret Never Transmitted) ---");

  const authHeader = createHashedBearerHeader(SECRET);

  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "What is the difference between encryption and hashing in one sentence?" }],
      max_tokens: 60
    })
  });

  if (!res.ok) {
    throw new Error(`Hashed token request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  console.log("Success! Response from model:");
  console.log(data.choices[0]?.message.content.trim());
}

async function main(): Promise<void> {
  try {
    await runHmacSignedRequest();
    await runHashedTokenRequest();
    console.log("\nAll multi-app cryptographic authentication checks passed!");
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("multi-app-crypto-client.ts")) {
  main();
}
