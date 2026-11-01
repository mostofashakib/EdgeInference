import type { MetricsRecorder } from "../../domain/interfaces/index.js";
import type { RequestMetric } from "../../domain/models/types.js";

export class StructuredMetricsRecorder implements MetricsRecorder {
  recordRequest(metric: RequestMetric): void {
    // Redact or safely output structured JSON metric without sensitive prompt or secret data
    const safeOutput = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "metric.request",
      requestId: metric.requestId,
      keyId: metric.keyId,
      model: metric.model,
      statusCode: metric.statusCode,
      durationMs: Math.round(metric.durationMs * 100) / 100,
      ttftMs: metric.ttftMs !== undefined ? Math.round(metric.ttftMs * 100) / 100 : undefined,
      inputTokens: metric.inputTokens,
      outputTokens: metric.outputTokens,
      imageCount: metric.imageCount,
      stream: metric.stream,
      error: metric.error
    });

    if (metric.statusCode >= 500) {
      console.error(safeOutput);
    } else {
      console.log(safeOutput);
    }
  }
}
