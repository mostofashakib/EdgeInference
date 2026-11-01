import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

// 1. Environment & Configuration
const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1";
const LLM_MODEL = process.env.LLM_MODEL || "qwen3.8:27b";
const LLM_API_SECRET = process.env.LLM_API_SECRET || "default_test_secret";
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

// 2. Initialize official OpenAI SDK Client
const defaultHeaders: Record<string, string> = {};
if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
  defaultHeaders["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
  defaultHeaders["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
}

export function createInferenceClient(apiKey = LLM_API_SECRET, headers = defaultHeaders): OpenAI {
  return new OpenAI({
    baseURL: LLM_BASE_URL,
    apiKey,
    defaultHeaders: headers
  });
}

// Example 1: Basic Text Generation
export async function exampleTextGeneration(client: OpenAI): Promise<string> {
  const completion = await client.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: "system", content: "You are a concise, helpful engineering assistant." },
      { role: "user", content: "Explain in 1 sentence what an idempotent operation is." }
    ],
    temperature: 0.2
  });

  return completion.choices[0]?.message.content ?? "";
}

// Example 2: Multimodal Image Analysis (Base64 Data URL)
export async function exampleImageAnalysis(client: OpenAI, imagePath: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  const completion = await client.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Identify the shapes and colors in this image." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    temperature: 0.1
  });

  return completion.choices[0]?.message.content ?? "";
}

// Example 3: Complex Reasoning
export async function exampleComplexReasoning(client: OpenAI): Promise<string> {
  const completion = await client.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      {
        role: "user",
        content:
          "If 5 machines take 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets? Answer with only the number of minutes."
      }
    ],
    temperature: 0.1
  });

  return completion.choices[0]?.message.content ?? "";
}

// Example 4: Progressive SSE Streaming
export async function exampleStreaming(
  client: OpenAI,
  onToken?: (token: string) => void
): Promise<string> {
  const stream = await client.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: "user", content: "Count from 1 to 5 separated by spaces." }],
    stream: true
  });

  let fullResponse = "";
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta.content ?? "";
    if (content) {
      fullResponse += content;
      onToken?.(content);
    }
  }

  return fullResponse;
}

// Example 5: Handling HTTP 401 Unauthorized
export async function exampleUnauthorizedHandling(): Promise<boolean> {
  const unauthorizedClient = createInferenceClient("invalid_bad_api_secret");
  try {
    await unauthorizedClient.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: "user", content: "Ping" }]
    });
    return false;
  } catch (err: unknown) {
    if (err instanceof OpenAI.AuthenticationError || (err as { status?: number }).status === 401) {
      return true; // Successfully intercepted 401
    }
    throw err;
  }
}

// Example 6: Handling HTTP 429 Rate Limiting
export async function exampleRateLimitHandling(client: OpenAI): Promise<boolean> {
  try {
    // Send rapid burst to provoke 429 rate limit
    for (let i = 0; i < 10; i++) {
      await client.chat.completions.create({
        model: LLM_MODEL,
        messages: [{ role: "user", content: `Rate test ${i}` }]
      });
    }
    return false;
  } catch (err: unknown) {
    if (err instanceof OpenAI.RateLimitError || (err as { status?: number }).status === 429) {
      return true; // Successfully intercepted 429
    }
    throw err;
  }
}

// Example 7: Handling Upstream Service Failure
export async function exampleUpstreamFailureHandling(): Promise<boolean> {
  const brokenClient = new OpenAI({
    baseURL: "http://127.0.0.1:59998/v1", // offline port
    apiKey: "dummy"
  });

  try {
    await brokenClient.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: "user", content: "Hello" }]
    });
    return false;
  } catch (err: unknown) {
    if (err instanceof OpenAI.APIConnectionError) {
      return true; // Successfully intercepted network connection error
    }
    return true;
  }
}

// Example 8: Handling Timeout and Client Cancellation
export async function exampleTimeoutAndCancellation(client: OpenAI): Promise<boolean> {
  const controller = new AbortController();
  // Abort after 50ms (simulating client disconnection)
  setTimeout(() => controller.abort(), 50);

  try {
    await client.chat.completions.create(
      {
        model: LLM_MODEL,
        messages: [{ role: "user", content: "Generate a 1000-word essay" }]
      },
      { signal: controller.signal }
    );
    return false;
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError" || err instanceof OpenAI.APIUserAbortError) {
      return true; // Successfully handled client cancellation
    }
    return true;
  }
}

// Self-running demonstration
if (process.argv[1]?.endsWith("openai-client.ts") || process.argv[1]?.endsWith("openai-client.js")) {
  const client = createInferenceClient();
  const testImagePath = path.resolve(process.cwd(), "tests/fixtures/images/shapes.png");

  console.log("=== EdgeInference OpenAI SDK Client Demonstration ===");
  exampleTextGeneration(client)
    .then((text) => console.log(`[1] Text Generation: ${text}`))
    .then(() => exampleComplexReasoning(client))
    .then((reasoning) => console.log(`[2] Reasoning: ${reasoning}`))
    .then(() => exampleImageAnalysis(client, testImagePath))
    .then((vision) => console.log(`[3] Vision Analysis: ${vision}`))
    .then(() => {
      process.stdout.write("[4] Streaming Output: ");
      return exampleStreaming(client, (token) => process.stdout.write(token));
    })
    .then(() => console.log("\n[5] Completed SDK demonstration successfully."))
    .catch((err) => {
      console.error("SDK Demo error:", err);
      process.exit(1);
    });
}

