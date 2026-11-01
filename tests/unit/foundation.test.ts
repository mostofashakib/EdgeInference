import { describe, it, expect } from "vitest";
import os from "node:os";
import Database from "better-sqlite3";
import sharp from "sharp";
import { timingSafeEqualString } from "../../gateway/src/domain/utils/timingSafe.js";

describe("M0 Foundation Tests", () => {
  describe("System Environment & Hardware", () => {
    it("runs on Apple Silicon arm64 architecture", () => {
      // Arrange & Act
      const arch = process.arch;

      // Assert
      expect(arch).toBe("arm64");
    });

    it("runs on Node.js 24 LTS runtime", () => {
      // Arrange & Act
      const nodeMajor = process.versions.node.split(".")[0];

      // Assert
      expect(nodeMajor).toBe("24");
    });

    it("has at least 32GB unified system memory", () => {
      // Arrange & Act
      const totalMemGiB = os.totalmem() / (1024 * 1024 * 1024);

      // Assert: target machine is 64GB M1 Max, threshold >= 32GB
      expect(totalMemGiB).toBeGreaterThanOrEqual(32);
    });
  });

  describe("Native Modules Compatibility (Apple Silicon arm64)", () => {
    it("initializes SQLite in WAL mode and executes atomic operations", () => {
      // Arrange
      const db = new Database(":memory:");

      // Act
      db.pragma("journal_mode = WAL");
      db.prepare(`
        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        )
      `).run();

      const insert = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)");
      const transaction = db.transaction((entries: Array<[string, number]>) => {
        for (const [k, v] of entries) {
          insert.run(k, v);
        }
      });
      transaction([["k1", 10], ["k2", 20]]);

      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get("k1") as { value: number };
      db.close();

      // Assert
      expect(row).toBeDefined();
      expect(row.value).toBe(10);
    });

    it("processes and measures image dimensions with sharp", async () => {
      // Arrange: create a 200x100 PNG test image
      const width = 200;
      const height = 100;
      const imageBuffer = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 128, b: 255, alpha: 1 }
        }
      })
        .png()
        .toBuffer();

      // Act: inspect metadata
      const metadata = await sharp(imageBuffer).metadata();

      // Assert
      expect(metadata.width).toBe(width);
      expect(metadata.height).toBe(height);
      expect(metadata.format).toBe("png");
      expect(metadata.channels).toBe(4);
    });
  });

  describe("Domain Utility: timingSafeEqualString", () => {
    it("returns true for matching strings", () => {
      // Arrange
      const secret = "a".repeat(64);
      const input = "a".repeat(64);

      // Act
      const result = timingSafeEqualString(secret, input);

      // Assert
      expect(result).toBe(true);
    });

    it("returns false for non-matching strings of equal length", () => {
      // Arrange
      const secret = "a".repeat(64);
      const input = "a".repeat(63) + "b";

      // Act
      const result = timingSafeEqualString(secret, input);

      // Assert
      expect(result).toBe(false);
    });

    it("returns false for non-matching strings of different lengths", () => {
      // Arrange
      const secret = "a".repeat(64);
      const input = "a".repeat(32);

      // Act
      const result = timingSafeEqualString(secret, input);

      // Assert
      expect(result).toBe(false);
    });

    it("returns false for non-string inputs", () => {
      // Arrange & Act & Assert
      // @ts-expect-error testing invalid input types
      expect(timingSafeEqualString(null, "abc")).toBe(false);
      // @ts-expect-error testing invalid input types
      expect(timingSafeEqualString("abc", undefined)).toBe(false);
    });
  });
});
