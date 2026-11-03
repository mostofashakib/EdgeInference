import { z } from "zod";

const LoadedModelsSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
    size: z.number().nonnegative(),
    size_vram: z.number().nonnegative().optional()
  }))
});

export interface ModelAllocation {
  model: string;
  sizeBytes: number;
  vramBytes: number;
  executionMode: "cpu" | "gpu" | "mixed" | "unknown";
}

// Ask the inference host to allocate the model. Gateway RAM does not describe
// remote host capacity, and model file size excludes context and runtime memory.
export async function checkModelReadiness(
  baseUrl: string,
  models: readonly string[],
  timeoutMs = 300_000,
  signal?: AbortSignal
): Promise<ModelAllocation[]> {
  const endpoint = baseUrl.replace(/\/$/, "");
  const allocations: ModelAllocation[] = [];
  for (const model of models) {
    try {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false }),
        signal: requestSignal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const result = z.object({ done: z.literal(true) }).safeParse(await response.json());
      if (!result.success) throw new Error("Ollama did not confirm model load completion");
      const status = await fetch(`${endpoint}/api/ps`, { signal: requestSignal });
      if (!status.ok) throw new Error(`Allocation inspection returned HTTP ${status.status}`);
      const loaded = LoadedModelsSchema.parse(await status.json()).models;
      const name = model.includes(":") ? model : `${model}:latest`;
      const allocation = loaded.find((entry) => entry.name === name);
      if (!allocation) throw new Error("Model is not loaded, check available backend memory and Ollama logs");
      const vram = allocation.size_vram;
      const executionMode = vram === undefined ? "unknown" : vram === 0 ? "cpu" : vram >= allocation.size ? "gpu" : "mixed";
      allocations.push({ model, sizeBytes: allocation.size, vramBytes: vram ?? 0, executionMode });
    } catch (error) {
      throw new Error(`Model ${model} at ${endpoint} failed readiness: ${(error as Error).message}`, { cause: error });
    }
  }
  return allocations;
}
