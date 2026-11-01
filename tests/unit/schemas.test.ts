import { describe, it, expect } from "vitest";
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ChatCompletionChunkSchema,
  ErrorResponseSchema
} from "../../gateway/src/http/schemas/chatCompletion.js";

describe("Chat Completion Input and Output Schemas", () => {
  it("validates a compliant text chat completion request", () => {
    const input = {
      model: "qwen3.8:27b",
      messages: [
        { role: "system", content: "You are a concise assistant." },
        { role: "user", content: "Explain functional programming." }
      ],
      temperature: 0.5,
      max_tokens: 256,
      stream: false
    };

    const result = ChatCompletionRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("validates a compliant multimodal chat completion request with Base64 image", () => {
    const input = {
      model: "qwen3.8:27b",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is shown in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } }
          ]
        }
      ]
    };

    const result = ChatCompletionRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects unknown parameters in request schema due to strict mode", () => {
    const input = {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "Hello" }],
      unsupported_extra_param: true
    };

    const result = ChatCompletionRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("validates a compliant non-streaming chat completion output response", () => {
    const output = {
      id: "chatcmpl-test-1234567890",
      object: "chat.completion",
      created: 1730000000,
      model: "qwen3.8:27b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Functional programming emphasizes immutable state and pure functions."
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 28,
        completion_tokens: 11,
        total_tokens: 39
      }
    };

    const result = ChatCompletionResponseSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("validates a compliant progressive streaming chunk output response", () => {
    const chunk = {
      id: "chatcmpl-test-chunk-1234",
      object: "chat.completion.chunk",
      created: 1730000000,
      model: "qwen3.8:27b",
      choices: [
        {
          index: 0,
          delta: {
            content: "Hello"
          },
          finish_reason: null
        }
      ]
    };

    const result = ChatCompletionChunkSchema.safeParse(chunk);
    expect(result.success).toBe(true);
  });

  it("validates a compliant error response schema", () => {
    const err = {
      error: {
        message: "Inference service is at capacity. Please try again shortly.",
        type: "rate_limit_error",
        param: null,
        code: "inference_busy"
      }
    };

    const result = ErrorResponseSchema.safeParse(err);
    expect(result.success).toBe(true);
  });
});

