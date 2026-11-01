import { describe, it, expect } from "vitest";
import { SemaphoreAdmissionController } from "../../gateway/src/infrastructure/concurrency/SemaphoreAdmissionController.js";
import { ConcurrencyLimitError } from "../../gateway/src/domain/errors/index.js";

describe("SemaphoreAdmissionController", () => {
  it("admits first request immediately when slot is free", async () => {
    const controller = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });

    const lease = await controller.acquire();
    expect(lease.leaseId).toBeDefined();
    expect(controller.activeCount).toBe(1);
    expect(controller.queuedCount).toBe(0);

    await lease.release();
    expect(controller.activeCount).toBe(0);
  });

  it("queues requests up to maxQueue capacity and admits upon lease release", async () => {
    const controller = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });

    // Request 1 acquires active slot
    const lease1 = await controller.acquire();
    expect(controller.activeCount).toBe(1);

    // Request 2 queues
    let lease2Acquired = false;
    const p2 = controller.acquire().then((l) => {
      lease2Acquired = true;
      return l;
    });
    expect(controller.queuedCount).toBe(1);
    expect(lease2Acquired).toBe(false);

    // Request 3 queues (queue full at 2)
    let lease3Acquired = false;
    const p3 = controller.acquire().then((l) => {
      lease3Acquired = true;
      return l;
    });
    expect(controller.queuedCount).toBe(2);
    expect(lease3Acquired).toBe(false);

    // Release lease1 -> lease2 should acquire active slot
    await lease1.release();
    const lease2 = await p2;
    expect(lease2Acquired).toBe(true);
    expect(controller.activeCount).toBe(1);
    expect(controller.queuedCount).toBe(1);

    // Release lease2 -> lease3 should acquire active slot
    await lease2.release();
    const lease3 = await p3;
    expect(lease3Acquired).toBe(true);
    expect(controller.activeCount).toBe(1);
    expect(controller.queuedCount).toBe(0);

    // Release lease3 -> free
    await lease3.release();
    expect(controller.activeCount).toBe(0);
  });

  it("rejects immediately with ConcurrencyLimitError when queue is at capacity", async () => {
    const controller = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });

    const lease1 = await controller.acquire();
    const p2 = controller.acquire();
    const p3 = controller.acquire();

    // 4th request must be rejected immediately with 429
    await expect(controller.acquire()).rejects.toThrow(ConcurrencyLimitError);

    // Clean up
    await lease1.release();
    const lease2 = await p2;
    await lease2.release();
    const lease3 = await p3;
    await lease3.release();
  });

  it("handles client cancellation while waiting in queue", async () => {
    const controller = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });

    const lease1 = await controller.acquire();

    const abortController = new AbortController();
    const p2 = controller.acquire(abortController.signal);
    expect(controller.queuedCount).toBe(1);

    // Abort p2 while waiting
    abortController.abort();

    await expect(p2).rejects.toThrow(/abort/i);
    expect(controller.queuedCount).toBe(0);

    // Release lease1: activeCount should drop to 0 because p2 was cancelled
    await lease1.release();
    expect(controller.activeCount).toBe(0);
  });

  it("protects against double release", async () => {
    const controller = new SemaphoreAdmissionController({ maxActive: 1, maxQueue: 2 });

    const lease = await controller.acquire();
    expect(controller.activeCount).toBe(1);

    await lease.release();
    expect(controller.activeCount).toBe(0);

    // Second release should be a no-op
    await lease.release();
    expect(controller.activeCount).toBe(0);
  });
});
