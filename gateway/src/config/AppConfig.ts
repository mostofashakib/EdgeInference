import { z } from "zod";

export const AppConfigSchema = z.object({
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  port: z.coerce.number().int().positive().default(8765),
  host: z.string().default("127.0.0.1"),

  // Primary API secret and optional secondary secret for rotation
  primaryApiKey: z.string().min(1, "LLM_API_SECRET is required"),
  secondaryApiKey: z.string().optional(),
  guestApiKeys: z.array(z.string()).default([]),
  guestDailyQuota: z.coerce.number().int().positive().default(10),
  guestRateLimitPerMinute: z.coerce.number().int().positive().default(3),

  // Cloudflare Access Service Token Configuration (only active when explicitly true or "true")
  cfAccessEnabled: z.preprocess(
    (val) => val === true || val === "true" || val === "1",
    z.boolean()
  ).default(false),
  cfAccessClientId: z.string().optional(),
  cfAccessClientSecret: z.string().optional(),

  ollamaBaseUrl: z.string().url().default("http://127.0.0.1:11434"),
  allowedModels: z.array(z.string().trim().min(1)).min(1).default(["qwen3.8:27b"]),

  maxActiveInference: z.coerce.number().int().positive().default(1),
  maxQueueCapacity: z.coerce.number().int().nonnegative().default(2),
  dailyRequestQuota: z.coerce.number().int().positive().default(100),

  maxBodyBytes: z.coerce.number().int().positive().default(12 * 1024 * 1024), // 12 MiB
  maxImageBytes: z.coerce.number().int().positive().default(4 * 1024 * 1024), // 4 MiB
  maxImageCount: z.coerce.number().int().positive().default(2),
  maxImageMegapixels: z.coerce.number().int().positive().default(20),
  maxPromptChars: z.coerce.number().int().positive().default(32000),
  maxOutputTokens: z.coerce.number().int().positive().default(4096),

  databasePath: z.string().default("./data/gateway.db")
}).refine(
  (config) => {
    // In production, require at least 32 bytes (64 hex characters) of entropy
    if (config.nodeEnv === "production") {
      return config.primaryApiKey.length >= 64;
    }
    return true;
  },
  {
    message: "Production API secret must have at least 256 bits of entropy (minimum 64 characters).",
    path: ["primaryApiKey"]
  }
);

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const raw = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    primaryApiKey: env.LLM_API_SECRET,
    secondaryApiKey: env.LLM_API_SECRET_PREVIOUS,
    guestApiKeys: env.LLM_GUEST_API_KEYS ? env.LLM_GUEST_API_KEYS.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    guestDailyQuota: env.GUEST_DAILY_QUOTA ?? env.DAILY_REQUEST_QUOTA,
    guestRateLimitPerMinute: env.GUEST_RATE_LIMIT_PER_MINUTE,
    cfAccessEnabled: env.CF_ACCESS_ENABLED,
    cfAccessClientId: env.CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    allowedModels: env.ALLOWED_MODELS !== undefined ? env.ALLOWED_MODELS.split(",").map((s) => s.trim()) : env.LLM_MODEL ? [env.LLM_MODEL] : undefined,
    maxActiveInference: env.MAX_ACTIVE_INFERENCE,
    maxQueueCapacity: env.MAX_QUEUE_CAPACITY,
    dailyRequestQuota: env.DAILY_REQUEST_QUOTA,
    maxBodyBytes: env.MAX_BODY_BYTES,
    maxImageBytes: env.MAX_IMAGE_BYTES,
    maxImageCount: env.MAX_IMAGE_COUNT,
    maxImageMegapixels: env.MAX_IMAGE_MEGAPIXELS,
    maxPromptChars: env.MAX_PROMPT_CHARS,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    databasePath: env.DATABASE_PATH
  };

  return AppConfigSchema.parse(raw);
}

