import type { AppConfig } from "../config/AppConfig.js";
import { BearerTokenAuthenticator } from "../infrastructure/auth/BearerTokenAuthenticator.js";
import { CloudflareAccessValidator } from "../infrastructure/auth/CloudflareAccessValidator.js";
import { SystemClock } from "../infrastructure/observability/SystemClock.js";
import { StructuredMetricsRecorder } from "../infrastructure/observability/StructuredMetricsRecorder.js";
import { SharpImageProcessor } from "../infrastructure/images/SharpImageProcessor.js";
import { OllamaInferenceClient } from "../infrastructure/ollama/OllamaInferenceClient.js";
import { SqliteQuotaRepository } from "../infrastructure/persistence/SqliteQuotaRepository.js";
import { SemaphoreAdmissionController } from "../infrastructure/concurrency/SemaphoreAdmissionController.js";
import type {
  InferenceClient,
  ApiKeyAuthenticator,
  AccessValidator,
  QuotaRepository,
  AdmissionController,
  ImageProcessor,
  Clock,
  MetricsRecorder
} from "../domain/interfaces/index.js";
import type { AppDependencies } from "../app.js";

export interface DependencyOverrides {
  authenticator?: ApiKeyAuthenticator | undefined;
  accessValidator?: AccessValidator | undefined;
  inferenceClient?: InferenceClient | undefined;
  quotaRepository?: QuotaRepository | undefined;
  admissionController?: AdmissionController | undefined;
  imageProcessor?: ImageProcessor | undefined;
  clock?: Clock | undefined;
  metricsRecorder?: MetricsRecorder | undefined;
}

/**
 * Composition root creating the production dependency graph.
 */
export function createDependencies(
  config: AppConfig,
  overrides: DependencyOverrides = {}
): AppDependencies {
  const keys = [
    { keyId: "primary", secret: config.primaryApiKey }
  ];
  if (config.secondaryApiKey) {
    keys.push({ keyId: "secondary", secret: config.secondaryApiKey });
  }

  const authenticator = overrides.authenticator ?? new BearerTokenAuthenticator(keys);

  let accessValidator: AccessValidator | undefined = overrides.accessValidator;
  if (!accessValidator && config.cfAccessEnabled) {
    const tokens = [];
    if (config.cfAccessClientId && config.cfAccessClientSecret) {
      tokens.push({
        clientId: config.cfAccessClientId,
        clientSecret: config.cfAccessClientSecret
      });
    }
    accessValidator = new CloudflareAccessValidator({
      enabled: true,
      serviceTokens: tokens
    });
  }

  const clock = overrides.clock ?? new SystemClock();
  const metricsRecorder = overrides.metricsRecorder ?? new StructuredMetricsRecorder();
  const imageProcessor = overrides.imageProcessor ?? new SharpImageProcessor({
    maxBytes: config.maxImageBytes,
    maxMegapixels: config.maxImageMegapixels,
    allowedFormats: ["jpeg", "png", "webp"]
  });
  const inferenceClient = overrides.inferenceClient ?? new OllamaInferenceClient(config.ollamaBaseUrl);
  const quotaRepository = overrides.quotaRepository ?? new SqliteQuotaRepository(config.databasePath);
  const admissionController = overrides.admissionController ?? new SemaphoreAdmissionController({
    maxActive: config.maxActiveInference,
    maxQueue: config.maxQueueCapacity
  });

  return {
    config,
    authenticator,
    accessValidator,
    inferenceClient,
    quotaRepository,
    admissionController,
    imageProcessor,
    clock,
    metricsRecorder
  };
}
