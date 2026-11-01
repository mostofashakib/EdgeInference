import sharp, { type Sharp } from "sharp";
import type { ImageProcessor } from "../../domain/interfaces/index.js";
import type { ImageInput, NormalizedImage } from "../../domain/models/types.js";
import { InvalidRequestError } from "../../domain/errors/index.js";

export interface SharpImageProcessorOptions {
  maxBytes: number;
  maxMegapixels: number;
  allowedFormats: Array<"jpeg" | "png" | "webp">;
}

export class SharpImageProcessor implements ImageProcessor {
  constructor(private readonly options: SharpImageProcessorOptions) {}

  private verifyMagicBytes(buffer: Buffer): "jpeg" | "png" | "webp" | null {
    if (buffer.length < 12) return null;

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpeg";
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return "png";
    }

    // WebP: RIFF....WEBP
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "webp";
    }

    return null;
  }

  async validateAndNormalize(input: ImageInput): Promise<NormalizedImage> {
    const { buffer } = input;

    // 1. Buffer byte size check
    if (buffer.length > this.options.maxBytes) {
      const maxMb = (this.options.maxBytes / (1024 * 1024)).toFixed(1);
      throw new InvalidRequestError(
        `Image buffer size (${(buffer.length / (1024 * 1024)).toFixed(1)} MB) exceeds maximum allowed limit of ${maxMb} MB.`,
        "image"
      );
    }

    // 2. Magic bytes format verification
    const detectedFormat = this.verifyMagicBytes(buffer);
    if (!detectedFormat) {
      throw new InvalidRequestError(
        "Invalid or unsupported image format. File header signature does not match JPEG, PNG, or WebP.",
        "image"
      );
    }

    if (!this.options.allowedFormats.includes(detectedFormat)) {
      throw new InvalidRequestError(
        `Image format '${detectedFormat}' is not in the allowed list: ${this.options.allowedFormats.join(", ")}`,
        "image"
      );
    }

    const maxPixels = this.options.maxMegapixels * 1_000_000;

    // 3. Inspect metadata with Sharp and guard against decompression bombs
    let instance: Sharp;
    try {
      instance = sharp(buffer, {
        failOn: "error",
        limitInputPixels: maxPixels
      });

      const metadata = await instance.metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      const totalPixels = width * height;

      if (width <= 0 || height <= 0) {
        throw new InvalidRequestError("Corrupt image: dimensions cannot be determined.", "image");
      }

      if (totalPixels > maxPixels) {
        throw new InvalidRequestError(
          `Image dimensions (${width}x${height} = ${(totalPixels / 1_000_000).toFixed(1)} MP) exceed the maximum limit of ${this.options.maxMegapixels} megapixels.`,
          "image"
        );
      }

      // 4. Normalize and strip metadata (EXIF/GPS/ICC)
      let normalizedBuffer: Buffer;
      let mimeType: "image/jpeg" | "image/png" | "image/webp";

      if (detectedFormat === "png") {
        mimeType = "image/png";
        normalizedBuffer = await instance.png({ compressionLevel: 6 }).toBuffer();
      } else if (detectedFormat === "jpeg") {
        mimeType = "image/jpeg";
        normalizedBuffer = await instance.jpeg({ quality: 90 }).toBuffer();
      } else {
        mimeType = "image/webp";
        normalizedBuffer = await instance.webp({ quality: 90 }).toBuffer();
      }

      return {
        buffer: normalizedBuffer,
        mimeType,
        width,
        height,
        bytes: normalizedBuffer.length
      };
    } catch (err) {
      if (err instanceof InvalidRequestError) {
        throw err;
      }
      const msg = (err as Error).message || "";
      if (msg.includes("pixel limit") || msg.includes("exceeds pixel")) {
        throw new InvalidRequestError(
          `Image dimensions exceed the maximum allowed limit of ${this.options.maxMegapixels} megapixels.`,
          "image"
        );
      }
      throw new InvalidRequestError(
        `Failed to decode image: ${msg}`,
        "image"
      );
    }
  }
}
