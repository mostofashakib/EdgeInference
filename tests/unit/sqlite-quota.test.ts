import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SqliteQuotaRepository } from "../../gateway/src/infrastructure/persistence/SqliteQuotaRepository.js";

describe("SqliteQuotaRepository", () => {
  const testDbDir = path.resolve(process.cwd(), "data/test");
  const testDbPath = path.join(testDbDir, "quota-test.db");

  beforeEach(() => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("grants reservations and decrements remaining quota", async () => {
    const repo = new SqliteQuotaRepository(testDbPath);

    const res1 = await repo.reserve("key-1", "2026-11-01", 3);
    expect(res1.granted).toBe(true);
    expect(res1.remaining).toBe(2);
    expect(res1.limit).toBe(3);

    const res2 = await repo.reserve("key-1", "2026-11-01", 3);
    expect(res2.granted).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = await repo.reserve("key-1", "2026-11-01", 3);
    expect(res3.granted).toBe(true);
    expect(res3.remaining).toBe(0);

    // 4th request exceeds limit
    const res4 = await repo.reserve("key-1", "2026-11-01", 3);
    expect(res4.granted).toBe(false);
    expect(res4.remaining).toBe(0);

    repo.close();
  });

  it("isolates quotas across different keys and different periods", async () => {
    const repo = new SqliteQuotaRepository(testDbPath);

    // key-1 on period 1
    await repo.reserve("key-1", "2026-11-01", 1);
    const key1Excess = await repo.reserve("key-1", "2026-11-01", 1);
    expect(key1Excess.granted).toBe(false);

    // key-2 on period 1 is independent
    const key2Res = await repo.reserve("key-2", "2026-11-01", 1);
    expect(key2Res.granted).toBe(true);

    // key-1 on period 2 is independent
    const key1NextDay = await repo.reserve("key-1", "2026-11-02", 1);
    expect(key1NextDay.granted).toBe(true);

    repo.close();
  });

  it("persists quota state across repository instances (simulating process restart)", async () => {
    // Instance 1: consume 2 reservations
    const repo1 = new SqliteQuotaRepository(testDbPath);
    await repo1.reserve("key-persist", "2026-11-01", 3);
    await repo1.reserve("key-persist", "2026-11-01", 3);
    repo1.close();

    // Instance 2: open new connection to same file
    const repo2 = new SqliteQuotaRepository(testDbPath);
    const res3 = await repo2.reserve("key-persist", "2026-11-01", 3);
    expect(res3.granted).toBe(true);
    expect(res3.remaining).toBe(0);

    const res4 = await repo2.reserve("key-persist", "2026-11-01", 3);
    expect(res4.granted).toBe(false);

    repo2.close();
  });

  it("prevents race conditions with atomic SQLite transactions", async () => {
    const repo = new SqliteQuotaRepository(testDbPath);
    const limit = 20;

    // Dispatch 30 parallel reservations for a limit of 20
    const promises = Array.from({ length: 30 }, () =>
      repo.reserve("key-concurrent", "2026-11-01", limit)
    );

    const results = await Promise.all(promises);
    const grantedCount = results.filter((r) => r.granted).length;
    const deniedCount = results.filter((r) => !r.granted).length;

    expect(grantedCount).toBe(20);
    expect(deniedCount).toBe(10);

    repo.close();
  });
});
