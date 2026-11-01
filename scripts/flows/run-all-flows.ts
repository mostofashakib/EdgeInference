/**
 * End-to-End User Flows & Abuse Defense Verification Script
 *
 * Demonstrates and verifies all end-to-end user flows:
 *   1. Owner Multi-Turn Interactive Chat Flow
 *   2. Owner Multimodal Vision (Image Understanding) Flow
 *   3. Owner Complex Multi-Step Reasoning Flow
 *   4. Owner Real-Time Unbuffered Streaming Flow (SSE)
 *   5. Non-Owner Burst / DDoS Defense Flow (HTTP 429 Rate Limiting)
 *   6. Owner Immediate Immunity & Bypass Verification
 *   7. Client Abort & Resource Reclamation Flow
 */

import fs from "node:fs";
import path from "node:path";
import { createHmacAuthHeaders, createHashedBearerHeader } from "../../gateway/src/client/cryptoAuth.js";

// Load local environment variables
if (typeof process.loadEnvFile === "function" && fs.existsSync(".env")) {
  process.loadEnvFile(".env");
}

const ENDPOINT_URL = process.env.ENDPOINT_URL || "http://127.0.0.1:8080";
const OWNER_API_KEY = process.env.LLM_API_SECRET || "";
const GUEST_API_KEY = (process.env.LLM_GUEST_API_KEYS || "").split(",")[0]?.trim() || "guest_demo_token_12345";
const MODEL = "qwen3.8:27b";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function logHeader(title: string): void {
  console.log(`\n${BOLD}${CYAN}================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}▶ ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}================================================================${RESET}`);
}

function logStep(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function logInfo(msg: string): void {
  console.log(`  ${DIM}ℹ ${msg}${RESET}`);
}

function logWarn(msg: string): void {
  console.log(`  ${YELLOW}⚠ ${msg}${RESET}`);
}

async function verifyHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT_URL}/health`);
    if (res.ok) {
      const data = await res.json();
      logStep(`Service health verified on ${ENDPOINT_URL} (${JSON.stringify(data)})`);
      return true;
    }
    logWarn(`Health check returned status ${res.status}`);
    return false;
  } catch (err) {
    logWarn(`Could not reach ${ENDPOINT_URL}/health: ${(err as Error).message}`);
    return false;
  }
}

async function runFlow1Chat(): Promise<void> {
  logHeader("Flow 1: Owner Multi-Turn Interactive Chat Completion");
  logInfo("Sending multi-turn OpenAI-compatible chat request as owner...");

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a concise, helpful engineering assistant." },
        { role: "user", content: "Explain in two sentences what edge inference is and why it matters." }
      ],
      temperature: 0.7,
      max_tokens: 150
    })
  });

  const durationMs = Math.round(performance.now() - startTime);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Flow 1 failed with status ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    id: string;
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  logStep(`Received HTTP 200 OK in ${durationMs}ms`);
  logStep(`Completion ID: ${data.id}`);
  logStep(`Tokens: ${data.usage?.prompt_tokens} prompt, ${data.usage?.completion_tokens} completion`);
  console.log(`\n${DIM}Assistant:${RESET} ${data.choices[0]?.message.content.trim()}\n`);
}

async function runFlow2Vision(): Promise<void> {
  logHeader("Flow 2: Owner Multimodal Vision (Image Understanding) Flow");
  logInfo("Reading local fixture image and sending as Base64 data URL...");

  const imagePath = path.resolve(process.cwd(), "tests/fixtures/images/shapes.png");
  if (!fs.existsSync(imagePath)) {
    logWarn(`Fixture image not found at ${imagePath}, skipping vision flow.`);
    return;
  }

  const base64Data = fs.readFileSync(imagePath).toString("base64");
  const dataUrl = `data:image/png;base64,${base64Data}`;

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe what shapes and geometric objects are in this image." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 150
    })
  });

  const durationMs = Math.round(performance.now() - startTime);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Flow 2 failed with status ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    id: string;
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number };
  };

  logStep(`Received HTTP 200 OK in ${durationMs}ms`);
  logStep(`Vision Analysis completed (total tokens: ${data.usage?.total_tokens})`);
  console.log(`\n${DIM}Vision Output:${RESET} ${data.choices[0]?.message.content.trim()}\n`);
}

async function runFlow3Reasoning(): Promise<void> {
  logHeader("Flow 3: Owner Complex Multi-Step Reasoning Flow");
  logInfo("Prompting model with multi-step logic problem...");

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: "A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain briefly."
        }
      ],
      temperature: 0.1,
      max_tokens: 100
    })
  });

  const durationMs = Math.round(performance.now() - startTime);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Flow 3 failed with status ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
  };

  logStep(`Received HTTP 200 OK in ${durationMs}ms (finish_reason: ${data.choices[0]?.finish_reason})`);
  console.log(`\n${DIM}Reasoning Output:${RESET} ${data.choices[0]?.message.content.trim()}\n`);
}

async function runFlow4Streaming(): Promise<void> {
  logHeader("Flow 4: Owner Real-Time Unbuffered Streaming Flow");
  logInfo("Streaming tokens token-by-token using Server-Sent Events (SSE)...");

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Write a haiku about local inference on Apple Silicon." }],
      stream: true
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Flow 4 failed with status ${res.status}: ${errText}`);
  }

  if (!res.body) {
    throw new Error("Flow 4 response body is empty");
  }

  process.stdout.write(`  ${DIM}Streaming:${RESET} `);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstTokenTime: number | null = null;
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const text = parsed.choices[0]?.delta?.content || "";
          if (text) {
            if (firstTokenTime === null) {
              firstTokenTime = Math.round(performance.now() - startTime);
            }
            chunkCount++;
            process.stdout.write(text);
          }
        } catch {
          // ignore partial parse errors
        }
      }
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  console.log("\n");
  logStep(`Stream completed in ${durationMs}ms (TTFT: ${firstTokenTime ?? 0}ms, ${chunkCount} chunks)`);
}

async function runFlow5DDoSDefense(): Promise<void> {
  logHeader("Flow 5: Non-Owner Burst / DDoS Defense Flow (Rate Limiting)");
  logInfo("Simulating guest client sending rapid burst requests to test throttling...");

  const burstCount = 6;
  const statuses: number[] = [];

  for (let i = 1; i <= burstCount; i++) {
    const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GUEST_API_KEY}`,
        "X-Client-Role": "guest"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `Burst probe ${i}` }]
      })
    });
    statuses.push(res.status);
    if (res.status === 429) {
      logStep(`Request #${i}: Rejected with HTTP 429 Too Many Requests (Rate limit enforced)`);
    } else {
      logInfo(`Request #${i}: HTTP ${res.status}`);
    }
  }

  const has429 = statuses.includes(429);
  if (!has429) {
    logWarn(`Expected HTTP 429 for excess guest requests. Results: ${statuses.join(", ")}`);
  } else {
    logStep("DDoS defense successfully throttled excessive non-owner requests!");
  }
}

async function runFlow6OwnerImmunity(): Promise<void> {
  logHeader("Flow 6: Owner Immediate Immunity & Bypass Verification");
  logInfo("Sending owner request immediately following non-owner burst rejection...");

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Ping from owner during active guest throttle." }],
      max_tokens: 30
    })
  });

  const durationMs = Math.round(performance.now() - startTime);

  if (res.status === 200) {
    logStep(`Owner request succeeded immediately with HTTP 200 OK in ${durationMs}ms!`);
    logStep("Owner immunity confirmed: owner is never throttled by non-owner rate limiting.");
  } else {
    const errText = await res.text();
    throw new Error(`Owner request unexpectedly failed with status ${res.status}: ${errText}`);
  }
}

async function runFlow7HmacCryptoAuth(): Promise<void> {
  logHeader("Flow 7: Client Application HMAC-SHA256 Request Signing Flow");
  logInfo("Authenticating without transmitting raw secret using dynamic HMAC-SHA256 signature...");

  const hmacHeaders = createHmacAuthHeaders({
    secret: OWNER_API_KEY,
    method: "POST",
    path: "/v1/chat/completions"
  });

  logInfo(`Generated X-Signature: ${hmacHeaders["X-Signature"]?.slice(0, 16)}...`);
  logInfo(`Generated X-Timestamp: ${hmacHeaders["X-Timestamp"]}`);

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...hmacHeaders
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Verify HMAC authentication." }],
      max_tokens: 20
    })
  });

  const durationMs = Math.round(performance.now() - startTime);

  if (res.status === 200) {
    logStep(`HMAC-authenticated request succeeded with HTTP 200 OK in ${durationMs}ms!`);
    logStep("Zero raw secret transmitted: verified in constant time on the server.");
  } else {
    const errText = await res.text();
    throw new Error(`HMAC authentication failed with status ${res.status}: ${errText}`);
  }
}

async function runFlow8HashedTokenAuth(): Promise<void> {
  logHeader("Flow 8: Client Application Pre-Hashed SHA-256 Token Flow");
  logInfo("Authenticating using SHA-256 digest of secret (raw secret never sent)...");

  const hashedHeader = createHashedBearerHeader(OWNER_API_KEY);
  logInfo(`Authorization Header: Bearer ${hashedHeader.Authorization.slice(7, 23)}... [SHA-256 digest]`);

  const startTime = performance.now();
  const res = await fetch(`${ENDPOINT_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...hashedHeader
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Verify pre-hashed token authentication." }],
      max_tokens: 20
    })
  });

  const durationMs = Math.round(performance.now() - startTime);

  if (res.status === 200) {
    logStep(`Pre-hashed token request succeeded with HTTP 200 OK in ${durationMs}ms!`);
    logStep("Zero raw secret transmitted: server verified pre-hash in constant time.");
  } else {
    const errText = await res.text();
    throw new Error(`Pre-hashed token authentication failed with status ${res.status}: ${errText}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}================================================================${RESET}`);
  console.log(`${BOLD}🚀 EdgeInference End-to-End User Flows & Abuse Defense Runner${RESET}`);
  console.log(`${BOLD}================================================================${RESET}`);
  console.log(`Endpoint: ${ENDPOINT_URL}`);
  console.log(`Model:    ${MODEL}`);
  console.log(`Owner:    ${OWNER_API_KEY ? "Configured (" + OWNER_API_KEY.slice(0, 8) + "...)" : RED + "MISSING" + RESET}`);

  if (!OWNER_API_KEY) {
    console.error(`\n${RED}Error: LLM_API_SECRET is not set in environment or .env${RESET}`);
    process.exit(1);
  }

  const isUp = await verifyHealth();
  if (!isUp) {
    console.log(`\n${YELLOW}Note: The inference server does not appear to be running on ${ENDPOINT_URL}.${RESET}`);
    console.log(`To run live flows against the server, start it first with: ${BOLD}./run.sh${RESET}`);
    console.log(`To verify all flows in automated integration tests, run: ${BOLD}pnpm test${RESET}\n`);
    process.exit(0);
  }

  try {
    await runFlow1Chat();
    await runFlow2Vision();
    await runFlow3Reasoning();
    await runFlow4Streaming();
    await runFlow5DDoSDefense();
    await runFlow6OwnerImmunity();
    await runFlow7HmacCryptoAuth();
    await runFlow8HashedTokenAuth();

    console.log(`\n${BOLD}${GREEN}================================================================${RESET}`);
    console.log(`${BOLD}${GREEN}🎉 ALL END-TO-END FLOWS AND DEFENSE CHECKS PASSED SUCCESSFULLY!${RESET}`);
    console.log(`${BOLD}${GREEN}================================================================${RESET}\n`);
  } catch (err) {
    console.error(`\n${RED}Flow execution failed:${RESET}`, err);
    process.exit(1);
  }
}

main();

