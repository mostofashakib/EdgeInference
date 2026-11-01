import { z } from "zod";

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
  max_tokens: z.number().int().positive().max(4096).optional(),
  // Additional strict check: reject unsupported parameters
}).strict();

export type ChatCompletionRequestBody = z.infer<typeof ChatCompletionRequestSchema>;

