import { z } from "zod";

// ============================================================================
// 1. INPUT REQUEST SCHEMAS
// ============================================================================

export const ChatMessageContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().min(1)
    }).strict()
  }).strict()
]);

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([
    z.string().min(1),
    z.array(ChatMessageContentPartSchema).min(1)
  ])
}).strict();

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1).max(50),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(4096).optional()
}).strict();

export type ChatCompletionRequestBody = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatMessageContentPart = z.infer<typeof ChatMessageContentPartSchema>;

// ============================================================================
// 2. OUTPUT RESPONSE SCHEMAS (NON-STREAMING)
// ============================================================================

export const ChatCompletionUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative()
}).strict();

export const ChatCompletionMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string()
}).strict();

export const ChatCompletionChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: ChatCompletionMessageSchema,
  finish_reason: z.enum(["stop", "length", "abort"])
}).strict();

export const ChatCompletionResponseSchema = z.object({
  id: z.string().min(1),
  object: z.literal("chat.completion"),
  created: z.number().int().positive(),
  model: z.string().min(1),
  choices: z.array(ChatCompletionChoiceSchema).min(1),
  usage: ChatCompletionUsageSchema.optional()
}).strict();

export type ChatCompletionUsage = z.infer<typeof ChatCompletionUsageSchema>;
export type ChatCompletionMessage = z.infer<typeof ChatCompletionMessageSchema>;
export type ChatCompletionChoice = z.infer<typeof ChatCompletionChoiceSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

// ============================================================================
// 3. OUTPUT RESPONSE SCHEMAS (STREAMING SSE CHUNK)
// ============================================================================

export const ChatCompletionDeltaSchema = z.object({
  role: z.literal("assistant").optional(),
  content: z.string().optional()
}).strict();

export const ChatCompletionChunkChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: ChatCompletionDeltaSchema,
  finish_reason: z.enum(["stop", "length", "abort"]).nullable()
}).strict();

export const ChatCompletionChunkSchema = z.object({
  id: z.string().min(1),
  object: z.literal("chat.completion.chunk"),
  created: z.number().int().positive(),
  model: z.string().min(1),
  choices: z.array(ChatCompletionChunkChoiceSchema).min(1)
}).strict();

export type ChatCompletionDelta = z.infer<typeof ChatCompletionDeltaSchema>;
export type ChatCompletionChunkChoice = z.infer<typeof ChatCompletionChunkChoiceSchema>;
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;

// ============================================================================
// 4. ERROR RESPONSE SCHEMA
// ============================================================================

export const ErrorDetailSchema = z.object({
  message: z.string(),
  type: z.string(),
  param: z.string().nullable(),
  code: z.string()
}).strict();

export const ErrorResponseSchema = z.object({
  error: ErrorDetailSchema
}).strict();

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
