import { normalizeUploadUrl } from "@/lib/utils";
import { fetchWithReadRetry } from "./api-client";

export function validateSourceImage(file: Pick<File, "type" | "size">): string | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return "Upload a JPEG, PNG, or WebP image.";
  if (file.size === 0) return "This file is empty. Select another image.";
  if (file.size > 10 * 1024 * 1024) return "Choose an image smaller than 10 MB.";
  return null;
}

/** Download bytes, not a cross-origin link (browsers ignore its download attribute). */
export async function downloadContentMedia(url: string, title: string, fallbackExtension: string) {
  const response = await fetchWithReadRetry(normalizeUploadUrl(url));
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blob = await response.blob();
  if (!blob.size || blob.type.includes("text/html") || blob.type.includes("application/json")) throw new Error("The media is unavailable");
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" } as Record<string, string>)[blob.type] || fallbackExtension;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${title.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "content"}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
