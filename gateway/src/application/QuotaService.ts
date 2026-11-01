import type { Clock, QuotaRepository } from "../domain/interfaces/index.js";
import type { QuotaReservation } from "../domain/models/types.js";
import { QuotaExceededError } from "../domain/errors/index.js";

export class QuotaService {
  constructor(
    private readonly repository: QuotaRepository,
    private readonly clock: Clock,
    private readonly dailyLimit: number
  ) {}

  async checkAndReserve(keyId: string): Promise<QuotaReservation> {
    const now = this.clock.now();
    const period = now.toISOString().slice(0, 10); // YYYY-MM-DD

    const reservation = await this.repository.reserve(keyId, period, this.dailyLimit);
    if (!reservation.granted) {
      throw new QuotaExceededError(`Daily quota of ${this.dailyLimit} requests exceeded for key '${keyId}'.`);
    }
    return reservation;
  }

  async rollback(keyId: string): Promise<void> {
    const now = this.clock.now();
    const period = now.toISOString().slice(0, 10);
    await this.repository.rollback(keyId, period);
  }
}

