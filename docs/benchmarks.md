# EdgeInference Benchmarks & Performance Metrics

## Hardware Specification
- **Device**: Apple MacBook Pro
- **Chip**: Apple M1 Max (10-core CPU, 32-core GPU, 16-core Neural Engine)
- **Memory**: 64 GB Unified Memory
- **Operating System**: macOS 26.5.2 (Darwin arm64)
- **Inference Runtime**: Ollama v0.40.13 (Apple MLX Metal backend)
- **Model Target**: `qwen3.8:27b` (Q4 / nvfp4 quantized, 27.8B parameters, 262k context)
- **Model Digest**: `47951e4a666180bc2aedfc93c169472f2de783696fe196efbf063f5730ecf163`

## Performance Tracking Matrix

| Milestone | Configuration | Cold Start (ms) | Warm Start (ms) | TTFT (ms) | Output Tokens/sec | GPU / VRAM Allocation |
|---|---|---|---|---|---|---|
| **M1** | Ollama native (`qwen3.8:27b`) | 18,665 | 5,175 | 1,816 | ~13.0 tok/s | 100% GPU / 20.09 GB (MLX) |
| **M3** | Fastify Gateway + Ollama | - | - | - | - | - |
| **M4** | Gateway with Quota & Semaphore | - | - | - | - | - |
| **M5** | Nginx -> Fastify -> Ollama | - | - | - | - | - |
| **M6** | Cloudflare -> Nginx -> Gateway | - | - | - | - | - |

## Workload Latency Measurements (M1 Baseline)

1. **Cold Start Text Generation**: 18,665 ms (loads 20 GB into unified memory and compiles Metal kernels).
2. **Warm Start Text Generation**: 5,175 ms (generates full paragraph explanation).
3. **Known-Answer Logic/Math Reasoning**: 5,386 ms (bat-and-ball problem, outputs `$0.05`).
4. **Multimodal Vision Analysis**: 13,723 ms (processes 400x300 PNG with red square, blue circle, and text).
5. **Streaming Output**:
   - Time to First Token (TTFT): 1,816 ms
   - Total Stream Duration: 2,206 ms
   - Chunks Delivered: 9 chunks

## GPU & Hardware Utilization
- Ollama `/api/ps` reports: `runner: "mlx"`, `size_vram: 20094967544`, `size: 20094967544`.
- `ollama ps` reports `100% GPU` utilization with 0% CPU fallback.
- Context window: 262,144 tokens supported. Keepalive retention: 5 minutes idle timeout.
