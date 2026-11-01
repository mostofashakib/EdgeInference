import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { QuotaRepository } from "../../domain/interfaces/index.js";
import type { QuotaReservation } from "../../domain/models/types.js";

export class SqliteQuotaRepository implements QuotaRepository {
  private readonly db: DatabaseType;

  constructor(dbPath: string = "./data/gateway.db") {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    // Performance and concurrency settings
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_quotas (
        key_id TEXT NOT NULL,
        period TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key_id, period)
      );
    `);
  }

  async reserve(keyId: string, period: string, limit: number): Promise<QuotaReservation> {
    const now = new Date();
    const nowIso = now.toISOString();

    // Calculate resetAt as end of period day (23:59:59.999 UTC)
    const resetAt = new Date(`${period}T23:59:59.999Z`);

    const reserveTransaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT used_count FROM daily_quotas WHERE key_id = ? AND period = ?")
        .get(keyId, period) as { used_count: number } | undefined;

      const currentCount = row?.used_count ?? 0;

      if (currentCount >= limit) {
        return {
          granted: false,
          remaining: 0,
          limit,
          resetAt
        };
      }

      const nextCount = currentCount + 1;
      this.db
        .prepare(`
          INSERT INTO daily_quotas (key_id, period, used_count, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(key_id, period) DO UPDATE SET
            used_count = used_count + 1,
            updated_at = ?
        `)
        .run(keyId, period, nowIso, nowIso, nowIso);

      return {
        granted: true,
        remaining: Math.max(0, limit - nextCount),
        limit,
        resetAt
      };
    });

    return reserveTransaction.immediate();
  }

  async rollback(keyId: string, period: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE daily_quotas
        SET used_count = MAX(0, used_count - 1),
            updated_at = ?
        WHERE key_id = ? AND period = ?
      `)
      .run(nowIso, keyId, period);
  }

  getUsedCount(keyId: string, period: string): number {
    const row = this.db
      .prepare("SELECT used_count FROM daily_quotas WHERE key_id = ? AND period = ?")
      .get(keyId, period) as { used_count: number } | undefined;
    return row?.used_count ?? 0;
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}
