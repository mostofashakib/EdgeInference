import type {
  InferenceClient,
  QuotaRepository,
  AdmissionController,
  ImageProcessor,
  Clock,
  MetricsRecorder
} from "../../gateway/src/domain/interfaces/index.js";
import type {
  InferenceRequest,
  InferenceResponse,
  InferenceEvent,
  QuotaReservation,
  InferenceLease,
  ImageInput,
  NormalizedImage,
  RequestMetric
} from "../../gateway/src/domain/models/types.js";

export class FakeInferenceClient implements InferenceClient {
  public generateCallCount = 0;
  public streamCallCount = 0;
  public lastRequest?: InferenceRequest;
  public cannedResponse: InferenceResponse = {
    id: "fake-chatcmpl-123",
    object: "chat.completion",
    created: 1730000000,
    model: "qwen3.8:27b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello from FakeInferenceClient!"
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    }
  };

  public cannedEvents: InferenceEvent[] = [
    {
      id: "fake-chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1730000000,
      model: "qwen3.8:27b",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }]
    },
    {
      id: "fake-chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1730000000,
      model: "qwen3.8:27b",
      choices: [{ index: 0, delta: { content: " world!" }, finish_reason: null }]
    },
    {
      id: "fake-chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1730000000,
      model: "qwen3.8:27b",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    }
  ];

  async generate(request: InferenceRequest, _signal?: AbortSignal): Promise<InferenceResponse> {
    this.generateCallCount++;
    this.lastRequest = request;
    return this.cannedResponse;
  }

  async *stream(request: InferenceRequest, _signal?: AbortSignal): AsyncIterable<InferenceEvent> {
    this.streamCallCount++;
    this.lastRequest = request;
    for (const evt of this.cannedEvents) {
      yield evt;
    }
  }
}

export class FakeQuotaRepository implements QuotaRepository {
  public reserveCallCount = 0;
  public shouldGrant = true;
  public remainingQuota = 99;

  async reserve(_keyId: string, _period: string, limit: number): Promise<QuotaReservation> {
    this.reserveCallCount++;
    return {
      granted: this.shouldGrant,
      remaining: this.shouldGrant ? this.remainingQuota : 0,
      limit,
      resetAt: new Date(Date.now() + 86400000)
    };
  }

  async rollback(_keyId: string, _period: string): Promise<void> {
    this.remainingQuota++;
  }
}

export class FakeAdmissionController implements AdmissionController {
  public acquireCallCount = 0;
  public activeLeases: string[] = [];
  public shouldReject = false;

  async acquire(_signal?: AbortSignal): Promise<InferenceLease> {
    this.acquireCallCount++;
    if (this.shouldReject) {
      throw new Error("Admission queue full");
    }
    const leaseId = `fake-lease-${this.acquireCallCount}`;
    this.activeLeases.push(leaseId);

    return {
      leaseId,
      acquiredAt: new Date(),
      release: async () => {
        const idx = this.activeLeases.indexOf(leaseId);
        if (idx !== -1) {
          this.activeLeases.splice(idx, 1);
        }
      }
    };
  }
}

export class FakeImageProcessor implements ImageProcessor {
  public validateCallCount = 0;

  async validateAndNormalize(input: ImageInput): Promise<NormalizedImage> {
    this.validateCallCount++;
    return {
      buffer: input.buffer,
      mimeType: "image/png",
      width: 100,
      height: 100,
      bytes: input.buffer.length
    };
  }
}

export class FakeClock implements Clock {
  public currentTime = new Date("2026-11-01T12:00:00Z");

  now(): Date {
    return new Date(this.currentTime.getTime());
  }
}

export class FakeMetricsRecorder implements MetricsRecorder {
  public recorded: RequestMetric[] = [];

  recordRequest(metric: RequestMetric): void {
    this.recorded.push(metric);
  }
}

