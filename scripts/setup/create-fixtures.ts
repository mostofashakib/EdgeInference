import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

async function main(): Promise<void> {
  const fixturesDir = path.resolve(process.cwd(), "tests/fixtures/images");
  fs.mkdirSync(fixturesDir, { recursive: true });

  // 1. Create a 400x300 SVG with a red square, a blue circle, and text, then render as PNG
  const svgBuffer = Buffer.from(`
    <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="400" height="300" fill="#f0f0f0"/>
      <rect x="50" y="50" width="100" height="100" fill="#e74c3c"/>
      <circle cx="280" cy="150" r="60" fill="#3498db"/>
      <text x="50" y="220" font-family="sans-serif" font-size="24" fill="#2c3e50">EdgeInference Test</text>
    </svg>
  `);

  const validPngPath = path.join(fixturesDir, "shapes.png");
  await sharp(svgBuffer).png().toFile(validPngPath);
  console.log(`Created valid PNG fixture at ${validPngPath}`);

  // Also create a JPEG version
  const validJpgPath = path.join(fixturesDir, "shapes.jpg");
  await sharp(svgBuffer).jpeg().toFile(validJpgPath);
  console.log(`Created valid JPEG fixture at ${validJpgPath}`);

  // 2. Create a corrupt image (starts with PNG header but corrupted payload)
  const corruptPath = path.join(fixturesDir, "corrupt.png");
  const corruptBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
    0xff, 0xff, 0xff, 0xff // junk
  ]);
  fs.writeFileSync(corruptPath, corruptBuffer);
  console.log(`Created corrupt image fixture at ${corruptPath}`);
}

main().catch((err) => {
  console.error("Failed to generate fixtures:", err);
  process.exit(1);
});

