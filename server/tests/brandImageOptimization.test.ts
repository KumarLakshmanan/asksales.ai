import { describe, it, expect } from "@jest/globals";
import sharp from "sharp";
import { optimizeBrandImage } from "../utils/brandImageOptimization.js";
describe("brand image upload optimization", () => {
  it("bounds full images and thumbnails while preserving aspect ratio", async () => {
    const source = await sharp({
      create: {
        width: 3000,
        height: 1500,
        channels: 4,
        background: { r: 80, g: 110, b: 140, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer();
    const optimized = await optimizeBrandImage(source);
    expect(optimized.width).toBe(2400);
    expect(optimized.height).toBe(1200);
    const thumbnail = await sharp(optimized.thumbnail).metadata();
    expect(thumbnail.width).toBe(480);
    expect(thumbnail.height).toBe(240);
    expect(thumbnail.format).toBe("webp");
    const original = await sharp(optimized.buffer).metadata();
    expect(original.hasAlpha).toBe(true);
    expect(original.exif).toBeUndefined();
  });
  it("does not enlarge small images and rejects malformed image payloads", async () => {
    const source = await sharp({
      create: { width: 30, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const optimized = await optimizeBrandImage(source);
    expect(optimized.width).toBe(30);
    expect(optimized.height).toBe(20);
    await expect(
      optimizeBrandImage(Buffer.from("not an image")),
    ).rejects.toThrow();
  });
});
