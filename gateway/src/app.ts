import fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/AppConfig.js";
import type {
  InferenceClient,
  ApiKeyAuthenticator,
  AccessValidator,
  QuotaRepository,
  AdmissionController,
  ImageProcessor,
  Clock,
  MetricsRecorder
} from "./domain/interfaces/index.js";
import { QuotaService } from "./application/QuotaService.js";
import { InferenceService } from "./application/InferenceService.js";
import { ChatCompletionController } from "./http/controllers/ChatCompletionController.js";
import { DomainError, UnauthorizedError, PayloadTooLargeError } from "./domain/errors/index.js";

export interface AppDependencies {
  config: AppConfig;
  authenticator: ApiKeyAuthenticator;
  accessValidator?: AccessValidator | undefined;
  inferenceClient: InferenceClient;
  quotaRepository: QuotaRepository;
  admissionController: AdmissionController;
  imageProcessor: ImageProcessor;
  clock: Clock;
  metricsRecorder: MetricsRecorder;
}

export function createApp(deps: AppDependencies): FastifyInstance {
  const app = fastify({
    bodyLimit: deps.config.maxBodyBytes,
    logger: {
      level: deps.config.nodeEnv === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers['authorization']",
          "req.headers['cf-access-client-secret']",
          "req.headers['cf-access-client-id']",
          "req.headers['x-signature']",
          "req.headers['x-signature-256']",
          "req.headers['x-hashed-token']",
          "req.headers.cookie",
          "*.apiSecret",
          "*.secret",
          "*.key"
        ],
        censor: "[REDACTED]"
      }
    }
  });

  // Construct application services via manual dependency injection
  const quotaService = new QuotaService(
    deps.quotaRepository,
    deps.clock,
    deps.config.dailyRequestQuota,
    deps.config.guestDailyQuota,
    deps.config.guestRateLimitPerMinute
  );

  const inferenceService = new InferenceService(
    deps.inferenceClient,
    quotaService,
    deps.admissionController,
    deps.imageProcessor,
    deps.metricsRecorder,
    { allowedModels: deps.config.allowedModels }
  );

  const controller = new ChatCompletionController(inferenceService);

  // Global error handler: maps DomainError to OpenAI-compatible error schema
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send(error.toResponseJson());
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode: unknown }).statusCode === 413
    ) {
      const payloadErr = new PayloadTooLargeError("Request body exceeds maximum size limit.");
      return reply.status(413).send(payloadErr.toResponseJson());
    }

    // Default unhandled error (sanitized, zero secret leakage)
    return reply.status(500).send({
      error: {
        message: "An internal server error occurred.",
        type: "server_error",
        param: null,
        code: "internal_error"
      }
    });
  });

  // Mandatory Early Authentication Hook (onRequest lifecycle)
  app.addHook("onRequest", async (request, _reply) => {
    // Health check endpoint is exempt from authentication
    if (request.url === "/health" || request.url === "/live") {
      return;
    }

    // Step 1: Cloudflare Access Edge Validation (if configured)
    if (deps.accessValidator) {
      const accessResult = deps.accessValidator.validate(request.headers);
      if (!accessResult.valid) {
        throw new UnauthorizedError(accessResult.reason || "Cloudflare Access authentication failed");
      }
    }

    // Step 2: Gateway Cryptographic Authentication (HMAC-SHA256, Pre-hashed Token, or Bearer)
    const authHeader = request.headers.authorization;
    const authResult = deps.authenticator.authenticate(authHeader, {
      headers: request.headers,
      method: request.method,
      url: request.url,
      now: deps.clock.now()
    });

    if (!authResult.authenticated) {
      throw new UnauthorizedError(authResult.reason || "Unauthorized");
    }

    request.authKeyId = authResult.keyId;
    request.authRole = authResult.role ?? (authResult.keyId.startsWith("owner") ? "owner" : "guest");
  });

  // Health endpoint
  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({
      status: "healthy",
      timestamp: deps.clock.now().toISOString(),
      models: deps.config.allowedModels
    });
  });

  // OpenAI-Compatible Chat Completions Endpoint
  app.post("/v1/chat/completions", async (request, reply) => {
    await controller.handle(request, reply);
  });

  return app;
}
