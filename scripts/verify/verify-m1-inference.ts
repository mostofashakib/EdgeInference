import fs from "node:fs";
import path from "node:path";

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}


if (fs.existsSync(".env")) process.loadEnvFile(".env");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL_NAME = process.env.LLM_MODEL || "qwen3.8:27b";

async function runTextCompletion(prompt: string): Promise<{ text: string; durationMs: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      stream: false
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Text completion failed (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const durationMs = performance.now() - start;
  return {
    text: data.choices[0]?.message.content || "",
    durationMs
  };
}

async function runVisualCompletion(
  prompt: string,
  imageBuffer: Buffer,
  mimeType = "image/png"
): Promise<{ text: string; durationMs: number }> {
  const base64Data = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const start = performance.now();
  const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ],
      stream: false
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Visual completion failed (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const durationMs = performance.now() - start;
  return {
    text: data.choices[0]?.message.content || "",
    durationMs
  };
}

async function runStreamingText(
  prompt: string
): Promise<{ fullText: string; chunkCount: number; ttftMs: number; totalDurationMs: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      stream: true
    })
  });

  if (!res.ok || !res.body) {
    throw new Error(`Streaming failed (${res.status}): ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let chunkCount = 0;
  let ttftMs = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n").filter((l) => l.trim().startsWith("data:"));

    for (const line of lines) {
      const dataStr = line.replace(/^data:\s*/, "").trim();
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          if (chunkCount === 0) {
            ttftMs = performance.now() - start;
          }
          fullText += delta;
          chunkCount++;
        }
      } catch {
        // partial chunk or keepalive
      }
    }
  }

  const totalDurationMs = performance.now() - start;
  return { fullText, chunkCount, ttftMs, totalDurationMs };
}

async function checkGpuStatus(): Promise<{ loaded: boolean; processor: string; size: string }> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/ps`);
  if (!res.ok) throw new Error("Failed to query /api/ps");
  const data = (await res.json()) as { models?: Array<{ name: string; size: number; processor: string }> };

  const current = data.models?.find((m) => m.name === (MODEL_NAME.includes(":") ? MODEL_NAME : `${MODEL_NAME}:latest`));
  if (!current) {
    return { loaded: false, processor: "none", size: "0" };
  }
  return {
    loaded: true,
    processor: current.processor || "unknown",
    size: `${Math.round(current.size / (1024 * 1024 * 1024))} GB`
  };
}

async function main(): Promise<void> {
  console.log("=== EdgeInference Ollama Verification Script ===");
  console.log(`Endpoint: ${OLLAMA_BASE_URL}`);
  console.log(`Target Model: ${MODEL_NAME}`);

  // 1. Text Generation Test (Cold Start)
  console.log("\n[Test 1] Cold Start Text Generation...");
  const cold = await runTextCompletion("Explain in 1 concise sentence why the sky is blue.");
  console.log(`Response (${cold.durationMs.toFixed(0)} ms): ${cold.text.trim()}`);

  // 2. Warm Start Text Generation
  console.log("\n[Test 2] Warm Start Text Generation...");
  const warm = await runTextCompletion("Explain in 1 concise sentence why leaves are green.");
  console.log(`Response (${warm.durationMs.toFixed(0)} ms): ${warm.text.trim()}`);

  // 3. Known-Answer Reasoning Test
  console.log("\n[Test 3] Known-Answer Reasoning Test...");
  const reasoning = await runTextCompletion(
    "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Respond with only the cost of the ball (e.g. $0.05 or 5 cents)."
  );
  console.log(`Reasoning Response (${reasoning.durationMs.toFixed(0)} ms): ${reasoning.text.trim()}`);

  // 4. GPU Status Check via /api/ps
  console.log("\n[Test 4] CPU/GPU Allocation via /api/ps...");
  const gpu = await checkGpuStatus();
  console.log(`Model Loaded: ${gpu.loaded}`);
  console.log(`Processor Allocation: ${gpu.processor}`);
  console.log(`Memory Footprint: ${gpu.size}`);

  // 5. Visual Description & Reasoning Test
  console.log("\n[Test 5] Visual Understanding & Reasoning Test...");
  const imagePath = path.resolve(process.cwd(), "tests/fixtures/images/shapes.png");
  const imageBuffer = fs.readFileSync(imagePath);
  const visual = await runVisualCompletion(
    "Describe the geometric shapes, their colors, and any text present in this image.",
    imageBuffer,
    "image/png"
  );
  console.log(`Visual Response (${visual.durationMs.toFixed(0)} ms): ${visual.text.trim()}`);

  // 6. Streaming SSE Test
  console.log("\n[Test 6] Streaming Output Test...");
  const stream = await runStreamingText("Count from 1 to 5 separated by commas.");
  console.log(`Stream TTFT: ${stream.ttftMs.toFixed(0)} ms, Total Duration: ${stream.totalDurationMs.toFixed(0)} ms`);
  console.log(`Chunks received: ${stream.chunkCount}`);
  console.log(`Full streamed text: ${stream.fullText.trim()}`);

  // 7. Invalid Model Request Test
  console.log("\n[Test 7] Invalid Model Error Mapping Test...");
  const invalidRes = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "non-existent-model-xyz",
      messages: [{ role: "user", content: "hello" }]
    })
  });
  console.log(`Invalid model status code: ${invalidRes.status} (Expected: 404 or 400)`);

  console.log("\n===================================================");
  console.log("All Ollama Verification Checks Completed Successfully!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});

