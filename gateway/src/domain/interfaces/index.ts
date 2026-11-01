import type {
  InferenceRequest,
  InferenceResponse,
  InferenceEvent,
  AuthenticationResult,
  QuotaReservation,
  InferenceLease,
  ImageInput,
  NormalizedImage,
  RequestMetric
} from "../models/types.js";

export interface InferenceClient {
  generate(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResponse>;
  stream(request: InferenceRequest, signal?: AbortSignal): AsyncIterable<InferenceEvent> | Promise<AsyncIterable<InferenceEvent>>;
}

export interface RequestAuthContext {
  headers?: Record<string, string | string[] | undefined> | undefined;
  method?: string | undefined;
  url?: string | undefined;
  now?: Date | undefined;
}

export interface ApiKeyAuthenticator {
  authenticate(
    authorizationHeader?: string,
    context?: RequestAuthContext
  ): AuthenticationResult;
}

export interface AccessValidator {
  validate(headers: Record<string, string | string[] | undefined>): { valid: boolean; reason?: string | undefined };
}

export interface QuotaRepository {
  reserve(keyId: string, period: string, limit: number): Promise<QuotaReservation>;
  rollback(keyId: string, period: string): Promise<void>;
}

export interface AdmissionController {
  acquire(signal?: AbortSignal): Promise<InferenceLease>;
}

export interface ImageProcessor {
  validateAndNormalize(input: ImageInput): Promise<NormalizedImage>;
}

export interface Clock {
  now(): Date;
}

export interface MetricsRecorder {
  recordRequest(metric: RequestMetric): void;
}
