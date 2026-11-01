import type { AppConfig } from "../config/AppConfig.js";
import { BearerTokenAuthenticator } from "../infrastructure/auth/BearerTokenAuthenticator.js";
import { SystemClock } from "../infrastructure/observability/SystemClock.js";
import { StructuredMetricsRecorder } from "../infrastructure/observability/StructuredMetricsRecorder.js";
import type {
  InferenceClient,
  ApiKeyAuthenticator,
  QuotaRepository,
  AdmissionController,
  ImageProcessor,
  Clock,
  MetricsRecorder
} from "../domain/interfaces/index.js";
import type { AppDependencies } from "../app.js";

export interface DependencyOverrides {
  authenticator?: ApiKeyAuthenticator | undefined;
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
  const clock = overrides.clock ?? new SystemClock();
  const metricsRecorder = overrides.metricsRecorder ?? new StructuredMetricsRecorder();

  if (!overrides.inferenceClient || !overrides.quotaRepository || !overrides.admissionController || !overrides.imageProcessor) {
    throw new Error(
      "Infrastructure clients (inference, quota, admission, imageProcessor) must be supplied via overrides or concrete modules."
    );
  }

  return {
    config,
    authenticator,
    inferenceClient: overrides.inferenceClient,
    quotaRepository: overrides.quotaRepository,
    admissionController: overrides.admissionController,
    imageProcessor: overrides.imageProcessor,
    clock,
    metricsRecorder
  };
}
