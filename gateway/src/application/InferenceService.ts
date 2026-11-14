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
  InferenceLease,
  ChatMessage,
  ClientRole
} from "../domain/models/types.js";
import { QuotaService } from "./QuotaService.js";
import {
  ModelNotAllowedError,
  InvalidRequestError
} from "../domain/errors/index.js";

export interface InferenceServiceOptions {
  allowedModels: string[];
  maxImageCount?: number;
  maxPromptChars?: number;
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

  private async processAndValidateMessages(messages: ChatMessage[]): Promise<{
    processedMessages: ChatMessage[];
    imageCount: number;
  }> {
    const maxImages = this.options.maxImageCount ?? 2;
    const maxChars = this.options.maxPromptChars ?? 32000;

    let imageCount = 0;
    let totalTextChars = 0;

    const processedMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        totalTextChars += msg.content.length;
        processedMessages.push(msg);
      } else if (Array.isArray(msg.content)) {
        const processedParts = [];

        for (const part of msg.content) {
          if (part.type === "text") {
            totalTextChars += part.text.length;
            processedParts.push(part);
          } else if (part.type === "image_url") {
            imageCount++;
            if (imageCount > maxImages) {
              throw new InvalidRequestError(
                `Too many images provided. A maximum of ${maxImages} images per request is permitted.`,
                "messages"
              );
            }

            const url = part.image_url.url;
            // Reject remote URLs (http/https)
            if (url.startsWith("http://") || url.startsWith("https://")) {
              throw new InvalidRequestError(
                "Remote image URLs are not permitted. Images must be supplied as Base64 data URLs.",
                "image_url"
              );
            }

            // Parse data URL format: data:<mimeType>;base64,<encoded>
            const match = url.match(/^data:([^;]+);base64,(.+)$/s);
            if (!match || !match[1] || !match[2]) {
              throw new InvalidRequestError(
                "Malformed image URL. Expected Base64 data URL: 'data:<mimeType>;base64,<data>'",
                "image_url"
              );
            }

            const mimeType = match[1].toLowerCase();
            const rawBase64 = match[2];
            const buffer = Buffer.from(rawBase64, "base64");

            // Validate, normalize, and strip metadata
            const normalized = await this.imageProcessor.validateAndNormalize({
              buffer,
              mimeType
            });

            // Replace with normalized base64 data URL
            processedParts.push({
              type: "image_url" as const,
              image_url: {
                url: `data:${normalized.mimeType};base64,${normalized.buffer.toString("base64")}`
              }
            });
          }
        }

        processedMessages.push({
          role: msg.role,
          content: processedParts
        });
      }
    }

    if (totalTextChars > maxChars) {
      throw new InvalidRequestError(
        `Total prompt text length (${totalTextChars} characters) exceeds the maximum allowed limit of ${maxChars} characters.`,
        "messages"
      );
    }

    return { processedMessages, imageCount };
  }

  private async admit(
    request: InferenceRequest,
    keyId: string,
    role: ClientRole,
    signal?: AbortSignal
  ): Promise<{
    sanitizedRequest: InferenceRequest;
    lease: InferenceLease;
    imageCount: number;
  }> {
    if (!this.options.allowedModels.includes(request.model)) {
      throw new ModelNotAllowedError(request.model);
    }

    const { processedMessages, imageCount } = await this.processAndValidateMessages(request.messages);
    const sanitizedRequest: InferenceRequest = {
      ...request,
      messages: processedMessages
    };

    await this.quotaService.checkAndReserve(keyId, role);

    let lease: InferenceLease;
    try {
      lease = await this.admissionController.acquire(signal);
    } catch (err) {
      await this.quotaService.rollback(keyId, role);
      throw err;
    }

    return { sanitizedRequest, lease, imageCount };
  }

  private recordFailure(params: {
    requestId: string;
    keyId: string;
    model: string;
    durationMs: number;
    imageCount: number;
    stream: boolean;
    ttftMs?: number | undefined;
    error: unknown;
  }): void {
    this.metricsRecorder.recordRequest({
      requestId: params.requestId,
      keyId: params.keyId,
      model: params.model,
      statusCode: 500,
      durationMs: params.durationMs,
      ttftMs: params.ttftMs,
      imageCount: params.imageCount,
      stream: params.stream,
      error: params.error instanceof Error ? params.error.message : String(params.error)
    });
  }

  async generate(
    request: InferenceRequest,
    keyId: string,
    requestId: string,
    signal?: AbortSignal,
    role: ClientRole = "owner"
  ): Promise<InferenceResponse> {
    const startTime = performance.now();
    const { sanitizedRequest, lease, imageCount } = await this.admit(request, keyId, role, signal);

    try {
      const response = await this.client.generate(sanitizedRequest, signal);
      const durationMs = performance.now() - startTime;

      this.metricsRecorder.recordRequest({
        requestId,
        keyId,
        model: request.model,
        statusCode: 200,
        durationMs,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        imageCount,
        stream: false
      });

      return response;
    } catch (err) {
      this.recordFailure({
        requestId,
        keyId,
        model: request.model,
        durationMs: performance.now() - startTime,
        imageCount,
        stream: false,
        error: err
      });
      throw err;
    } finally {
      await lease.release();
    }
  }

  async *stream(
    request: InferenceRequest,
    keyId: string,
    requestId: string,
    signal?: AbortSignal,
    role: ClientRole = "owner"
  ): AsyncIterable<InferenceEvent> {
    const startTime = performance.now();
    const { sanitizedRequest, lease, imageCount } = await this.admit(request, keyId, role, signal);
    let ttftMs: number | undefined;

    try {
      const eventStream = await this.client.stream(sanitizedRequest, signal);
      for await (const chunk of eventStream) {
        if (ttftMs === undefined) {
          ttftMs = performance.now() - startTime;
        }
        yield chunk;
      }

      this.metricsRecorder.recordRequest({
        requestId,
        keyId,
        model: request.model,
        statusCode: 200,
        durationMs: performance.now() - startTime,
        ttftMs,
        imageCount,
        stream: true
      });
    } catch (err) {
      this.recordFailure({
        requestId,
        keyId,
        model: request.model,
        durationMs: performance.now() - startTime,
        ttftMs,
        imageCount,
        stream: true,
        error: err
      });
      throw err;
    } finally {
      await lease.release();
    }
  }
}
