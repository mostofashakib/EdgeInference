import crypto from "node:crypto";
import type { AdmissionController } from "../../domain/interfaces/index.js";
import type { InferenceLease } from "../../domain/models/types.js";
import { ConcurrencyLimitError } from "../../domain/errors/index.js";

export interface SemaphoreAdmissionControllerOptions {
  maxActive: number;
  maxQueue: number;
}

interface QueuedRequest {
  id: string;
  resolve: (lease: InferenceLease) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal | undefined;
  cleanup?: () => void;
}

export class SemaphoreAdmissionController implements AdmissionController {
  private active = 0;
  private readonly queue: QueuedRequest[] = [];
  private readonly maxActive: number;
  private readonly maxQueue: number;

  constructor(options: SemaphoreAdmissionControllerOptions) {
    this.maxActive = options.maxActive;
    this.maxQueue = options.maxQueue;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private createLease(): InferenceLease {
    let released = false;
    const leaseId = `lease-${crypto.randomUUID()}`;
    const acquiredAt = new Date();

    return {
      leaseId,
      acquiredAt,
      release: async () => {
        if (released) return; // Idempotent double-release protection
        released = true;

        if (this.queue.length > 0) {
          const next = this.queue.shift();
          if (next) {
            next.cleanup?.();
            // Pass the active slot directly to the next waiting request
            next.resolve(this.createLease());
            return;
          }
        }

        this.active = Math.max(0, this.active - 1);
      }
    };
  }

  async acquire(signal?: AbortSignal): Promise<InferenceLease> {
    if (signal?.aborted) {
      throw new Error("Request aborted before acquiring inference slot");
    }

    // 1. Slot available immediately
    if (this.active < this.maxActive) {
      this.active++;
      return this.createLease();
    }

    // 2. Queue capacity exceeded: reject immediately with HTTP 429
    if (this.queue.length >= this.maxQueue) {
      throw new ConcurrencyLimitError(
        `Inference concurrency capacity exceeded (${this.maxActive} active, ${this.maxQueue} queued). Please try again shortly.`
      );
    }

    // 3. Enqueue and wait
    return new Promise<InferenceLease>((resolve, reject) => {
      const requestId = crypto.randomUUID();

      const onAbort = () => {
        const idx = this.queue.findIndex((r) => r.id === requestId);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new Error("Request aborted while queued"));
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      this.queue.push({
        id: requestId,
        resolve,
        reject,
        signal,
        cleanup
      });
    });
  }
}

