import type { Clock, QuotaRepository } from "../domain/interfaces/index.js";
import type { QuotaReservation, ClientRole } from "../domain/models/types.js";
import { QuotaExceededError, RateLimitExceededError } from "../domain/errors/index.js";

export class QuotaService {
  private readonly guestRequestTimestamps = new Map<string, number[]>();

  constructor(
    private readonly repository: QuotaRepository,
    private readonly clock: Clock,
    public readonly dailyLimit: number,
    public readonly guestDailyLimit: number = 10,
    public readonly guestRateLimitPerMinute: number = 3
  ) {}

  async checkAndReserve(keyId: string, role: ClientRole = "owner"): Promise<QuotaReservation> {
    const now = this.clock.now();
    const nowMs = now.getTime();

    // 1. The service owner is never throttled or quota-limited
    if (role === "owner") {
      return {
        granted: true,
        remaining: Infinity,
        limit: Infinity,
        resetAt: new Date(nowMs + 86400000)
      };
    }

    // 2. Everyone else (guests/external clients) is strictly rate-limited
    // Sliding window: filter timestamps in the last 60 seconds (60,000 ms)
    const windowStartMs = nowMs - 60_000;
    const timestamps = (this.guestRequestTimestamps.get(keyId) || []).filter((t) => t > windowStartMs);

    if (timestamps.length >= this.guestRateLimitPerMinute) {
      throw new RateLimitExceededError(
        `Rate limit exceeded. A maximum of ${this.guestRateLimitPerMinute} requests per minute is permitted for non-owner clients.`
      );
    }

    // 3. Persistent daily quota check
    const period = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const reservation = await this.repository.reserve(keyId, period, this.guestDailyLimit);
    if (!reservation.granted) {
      throw new QuotaExceededError(
        `Daily quota of ${this.guestDailyLimit} requests exceeded for key '${keyId}'.`
      );
    }

    // Record this successful request timestamp in sliding window
    timestamps.push(nowMs);
    this.guestRequestTimestamps.set(keyId, timestamps);

    return reservation;
  }

  async rollback(keyId: string, role: ClientRole = "owner"): Promise<void> {
    if (role === "owner") {
      return;
    }

    const now = this.clock.now();
    const period = now.toISOString().slice(0, 10);
    await this.repository.rollback(keyId, period);

    // Roll back the latest recorded timestamp if present
    const timestamps = this.guestRequestTimestamps.get(keyId);
    if (timestamps && timestamps.length > 0) {
      timestamps.pop();
    }
  }
}
