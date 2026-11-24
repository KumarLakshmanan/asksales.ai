export function creatorUploadError(file: File): string | null {
  const limits: Record<string, number> = { "image/jpeg": 10, "image/png": 10, "image/webp": 10, "image/gif": 10, "video/mp4": 100, "video/webm": 100, "video/quicktime": 100 };
  const limit = limits[file.type];
  if (!limit) return "Choose a JPEG, PNG, WebP, GIF, MP4, WebM, or MOV file.";
  if (!file.size) return "This file is empty. Choose another file.";
  if (file.size > limit * 1024 * 1024) return `${file.name} exceeds the ${limit} MB upload limit.`;
  return null;
}
