import type {
  InferenceClient,
  AdmissionController,
  ImageProcessor,
  MetricsRecorder
} from "../domain/interfaces/index.js";
import type {
  InferenceRequest,
  InferenceResponse,
  InferenceEvent,
  InferenceLease
} from "../domain/models/types.js";
import { QuotaService } from "./QuotaService.js";
import { ModelNotAllowedError } from "../domain/errors/index.js";

export interface InferenceServiceOptions {
  allowedModels: string[];
}

export class InferenceService {
  constructor(
    private readonly client: InferenceClient,
    private readonly quotaService: QuotaService,
    private readonly admissionController: AdmissionController,
    private readonly imageProcessor: ImageProcessor,
    private readonly metricsRecorder: MetricsRecorder,
    private readonly options: InferenceServiceOptions
  ) {}

  public getImageProcessor(): ImageProcessor {
    return this.imageProcessor;
  }

  async generate(
    request: InferenceRequest,
    keyId: string,
    requestId: string,
    signal?: AbortSignal
  ): Promise<InferenceResponse> {
    const startTime = performance.now();

    // 1. Model allowlist validation
    if (!this.options.allowedModels.includes(request.model)) {
      throw new ModelNotAllowedError(request.model);
    }

    // 2. Atomic daily quota check
    await this.quotaService.checkAndReserve(keyId);

    // 3. Concurrency lease acquisition
    const lease: InferenceLease = await this.admissionController.acquire(signal);

    try {
      // 4. Invoke inference client
      const response = await this.client.generate(request, signal);
      const durationMs = performance.now() - startTime;

      this.metricsRecorder.recordRequest({
        requestId,
        keyId,
        model: request.model,
        statusCode: 200,
        durationMs,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        imageCount: 0,
        stream: false
      });

      return response;
    } catch (err) {
      const durationMs = performance.now() - startTime;
      this.metricsRecorder.recordRequest({
        requestId,
        keyId,
        model: request.model,
        statusCode: 500,
        durationMs,
        imageCount: 0,
        stream: false,
        error: (err as Error).message
      });
      throw err;
    } finally {
      // Guaranteed resource reclamation
      await lease.release();
    }
  }

  async *stream(
    request: InferenceRequest,
    keyId: string,
    requestId: string,
    signal?: AbortSignal
  ): AsyncIterable<InferenceEvent> {
    const startTime = performance.now();

    // 1. Model allowlist validation
    if (!this.options.allowedModels.includes(request.model)) {
      throw new ModelNotAllowedError(request.model);
    }

    // 2. Atomic daily quota check
    await this.quotaService.checkAndReserve(keyId);

    // 3. Concurrency lease acquisition
    const lease: InferenceLease = await this.admissionController.acquire(signal);
    let ttftMs: number | undefined;

    try {
      const eventStream = await this.client.stream(request, signal);
      for await (const chunk of eventStream) {
        if (ttftMs === undefined) {
          ttftMs = performance.now() - startTime;
        }
        yield chunk;
      }

      const durationMs = performance.now() - startTime;
      this.metricsRecorder.recordRequest({
        requestId,
        keyId,
        model: request.model,
        statusCode: 200,
        durationMs,
        ttftMs,
        imageCount: 0,
        stream: true
      });
    } catch (err) {
      const durationMs = performance.now() - startTime;
      this.metricsRecorder.recordRequest({
        requestId,
        keyId,
        model: request.model,
        statusCode: 500,
        durationMs,
        ttftMs,
        imageCount: 0,
        stream: true,
        error: (err as Error).message
      });
      throw err;
    } finally {
      // Guaranteed resource reclamation
      await lease.release();
    }
  }
}
