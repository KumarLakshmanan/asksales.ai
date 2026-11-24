/**
 * Remembers the last header uploaded for a WhatsApp template, per sending
 * number, so choosing the template again does not ask for the same file.
 *
 * The server accepts an uploaded media ID for 29 days; we keep it for 28 so a
 * remembered upload is never offered after the server stops accepting it. Only
 * Meta's media ID, the file name and a small preview are kept, in this browser.
 */
export interface RememberedTemplateMedia {
  mediaId: string;
  mediaName: string;
  mediaPreview?: string;
  savedAt: number;
}

const MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
const PREVIEW_WIDTH = 480;

const storageKey = (providerAccountId: string, templateId: string) =>
  `whatsapp-template-media:${providerAccountId}:${templateId}`;

export function recallTemplateMedia(
  providerAccountId: string,
  templateId: string,
  now = Date.now(),
): RememberedTemplateMedia | null {
  try {
    const raw = localStorage.getItem(storageKey(providerAccountId, templateId));
    if (!raw) return null;
    const value = JSON.parse(raw) as RememberedTemplateMedia;
    if (!value?.mediaId || !value.mediaName || !(now - Number(value.savedAt) < MAX_AGE_MS)) {
      localStorage.removeItem(storageKey(providerAccountId, templateId));
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function rememberTemplateMedia(
  providerAccountId: string,
  templateId: string,
  media: Omit<RememberedTemplateMedia, "savedAt">,
): void {
  const value: RememberedTemplateMedia = { ...media, savedAt: Date.now() };
  try {
    localStorage.setItem(storageKey(providerAccountId, templateId), JSON.stringify(value));
  } catch {
    // Full or blocked storage (often the preview): keep the upload without it.
    try {
      localStorage.setItem(
        storageKey(providerAccountId, templateId),
        JSON.stringify({ ...value, mediaPreview: undefined }),
      );
    } catch {
      // Storage unavailable: the next send asks for the file again.
    }
  }
}

export function forgetTemplateMedia(providerAccountId: string, templateId: string): void {
  try {
    localStorage.removeItem(storageKey(providerAccountId, templateId));
  } catch {
    // Nothing stored.
  }
}

/** A small JPEG of an uploaded image for the remembered preview; undefined if it cannot be made. */
export async function imagePreviewDataUrl(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PREVIEW_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}
