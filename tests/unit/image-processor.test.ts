import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SharpImageProcessor } from "../../gateway/src/infrastructure/images/SharpImageProcessor.js";
import { InvalidRequestError } from "../../gateway/src/domain/errors/index.js";

describe("SharpImageProcessor", () => {
  const processor = new SharpImageProcessor({
    maxBytes: 4 * 1024 * 1024, // 4 MiB
    maxMegapixels: 20,
    allowedFormats: ["jpeg", "png", "webp"]
  });

  const fixturesDir = path.resolve(process.cwd(), "tests/fixtures/images");

  it("validates and normalizes a valid PNG image", async () => {
    // Arrange
    const pngPath = path.join(fixturesDir, "shapes.png");
    const buffer = fs.readFileSync(pngPath);

    // Act
    const result = await processor.validateAndNormalize({
      buffer,
      mimeType: "image/png"
    });

    // Assert
    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(400);
    expect(result.height).toBe(300);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.buffer).toBeInstanceOf(Buffer);

    // Verify metadata was stripped
    const meta = await sharp(result.buffer).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("validates and normalizes a valid JPEG image", async () => {
    // Arrange
    const jpgPath = path.join(fixturesDir, "shapes.jpg");
    const buffer = fs.readFileSync(jpgPath);

    // Act
    const result = await processor.validateAndNormalize({
      buffer,
      mimeType: "image/jpeg"
    });

    // Assert
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(400);
    expect(result.height).toBe(300);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("rejects corrupt image data", async () => {
    // Arrange
    const corruptPath = path.join(fixturesDir, "corrupt.png");
    const buffer = fs.readFileSync(corruptPath);

    // Act & Assert
    await expect(
      processor.validateAndNormalize({
        buffer,
        mimeType: "image/png"
      })
    ).rejects.toThrow(InvalidRequestError);
  });

  it("rejects non-image payloads disguised as images", async () => {
    // Arrange: plain text buffer claiming to be image/png
    const fakeBuffer = Buffer.from("<html><body>Not an image</body></html>");

    // Act & Assert
    await expect(
      processor.validateAndNormalize({
        buffer: fakeBuffer,
        mimeType: "image/png"
      })
    ).rejects.toThrow(InvalidRequestError);
  });

  it("rejects images exceeding maximum allowed size", async () => {
    // Arrange: 5 MB dummy buffer
    const bigBuffer = Buffer.alloc(5 * 1024 * 1024);

    // Act & Assert
    await expect(
      processor.validateAndNormalize({
        buffer: bigBuffer,
        mimeType: "image/png"
      })
    ).rejects.toThrow(/exceeds/i);
  });

  it("rejects decompression bombs exceeding maximum megapixels limit", async () => {
    // Arrange: small processor with 1 megapixel limit
    const strictProcessor = new SharpImageProcessor({
      maxBytes: 10 * 1024 * 1024,
      maxMegapixels: 1, // 1 MP = 1,000,000 pixels
      allowedFormats: ["png"]
    });

    // Create a 2000x1000 image (2,000,000 pixels = 2 MP > 1 MP)
    const largeDimensionBuffer = await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 3,
        background: { r: 100, g: 100, b: 100 }
      }
    })
      .png()
      .toBuffer();

    // Act & Assert
    await expect(
      strictProcessor.validateAndNormalize({
        buffer: largeDimensionBuffer,
        mimeType: "image/png"
      })
    ).rejects.toThrow(/megapixels/i);
  });
});

