import { describe, it, expect, beforeEach } from "vitest";
import { QuotaService } from "../../gateway/src/application/QuotaService.js";
import { FakeQuotaRepository, FakeClock } from "../fakes/index.js";
import { RateLimitExceededError, QuotaExceededError } from "../../gateway/src/domain/errors/index.js";

describe("QuotaService Role-Based Rate Limiting & Quotas", () => {
  let fakeRepo: FakeQuotaRepository;
  let fakeClock: FakeClock;
  let quotaService: QuotaService;

  beforeEach(() => {
    fakeRepo = new FakeQuotaRepository();
    fakeClock = new FakeClock(new Date("2026-11-01T12:00:00.000Z"));
    quotaService = new QuotaService(
      fakeRepo,
      fakeClock,
      100, // owner daily limit (unlimited anyway)
      10,  // guest daily limit
      3    // guest per-minute rate limit
    );
  });

  it("grants unlimited requests to the owner role without hitting repository or rate limits", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await quotaService.checkAndReserve("owner-primary", "owner");
      expect(res.granted).toBe(true);
      expect(res.remaining).toBe(Infinity);
      expect(res.limit).toBe(Infinity);
    }

    // Repository should not even be called for owner reservations
    expect(fakeRepo.reserveCallCount).toBe(0);
  });

  it("enforces sliding-window rate limit for guest role (rejects 4th request in same minute)", async () => {
    const guestKey = "guest-client-1";

    // 1st request: OK
    const r1 = await quotaService.checkAndReserve(guestKey, "guest");
    expect(r1.granted).toBe(true);

    // 2nd request: OK
    const r2 = await quotaService.checkAndReserve(guestKey, "guest");
    expect(r2.granted).toBe(true);

    // 3rd request: OK
    const r3 = await quotaService.checkAndReserve(guestKey, "guest");
    expect(r3.granted).toBe(true);

    // 4th request within same minute: must throw RateLimitExceededError (HTTP 429)
    await expect(quotaService.checkAndReserve(guestKey, "guest")).rejects.toThrow(
      RateLimitExceededError
    );
  });

  it("resets sliding-window rate limit for guest after 60 seconds", async () => {
    const guestKey = "guest-client-2";

    // Exhaust 3 requests
    await quotaService.checkAndReserve(guestKey, "guest");
    await quotaService.checkAndReserve(guestKey, "guest");
    await quotaService.checkAndReserve(guestKey, "guest");

    // 4th fails
    await expect(quotaService.checkAndReserve(guestKey, "guest")).rejects.toThrow(
      RateLimitExceededError
    );

    // Advance clock by 61 seconds
    fakeClock.advance(61000);

    // Now request should succeed
    const afterWindow = await quotaService.checkAndReserve(guestKey, "guest");
    expect(afterWindow.granted).toBe(true);
  });

  it("enforces daily quota limit for guest role (rejects when repository quota is exhausted)", async () => {
    const guestKey = "guest-client-3";

    // First request succeeds
    const res = await quotaService.checkAndReserve(guestKey, "guest");
    expect(res.granted).toBe(true);

    // Quota exhausted in repository
    fakeRepo.shouldGrant = false;
    fakeClock.advance(65000); // Beyond rate limit window

    await expect(quotaService.checkAndReserve(guestKey, "guest")).rejects.toThrow(
      QuotaExceededError
    );
  });

  it("rolls back guest reservation and timestamp on failure", async () => {
    const guestKey = "guest-client-4";

    await quotaService.checkAndReserve(guestKey, "guest");
    await quotaService.checkAndReserve(guestKey, "guest");
    await quotaService.checkAndReserve(guestKey, "guest");

    // At limit
    await expect(quotaService.checkAndReserve(guestKey, "guest")).rejects.toThrow(
      RateLimitExceededError
    );

    // Rollback one reservation
    await quotaService.rollback(guestKey, "guest");

    // Can now reserve again without rate limit error
    const retry = await quotaService.checkAndReserve(guestKey, "guest");
    expect(retry.granted).toBe(true);
  });
});
