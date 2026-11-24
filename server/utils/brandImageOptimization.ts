import sharp from "sharp";

/** Bound image dimensions, discard EXIF, and provide a small grid preview. */
export async function optimizeBrandImage(input: Buffer) {
  const image = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: 2400,
      height: 2400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  const thumbnail = await sharp(image.data)
    .resize({
      width: 480,
      height: 480,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 75 })
    .toBuffer();
  return {
    buffer: image.data,
    thumbnail,
    width: image.info.width,
    height: image.info.height,
    mimeType: "image/webp",
  };
}
