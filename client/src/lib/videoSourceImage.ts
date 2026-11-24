export type VideoImageRole = "reference" | "start_frame";

export const VIDEO_IMAGE_ROLES: Array<{ value: VideoImageRole; label: string; description: string }> = [
  {
    value: "reference",
    label: "Reference for the scene (recommended)",
    description: "The AI builds the scene your prompt describes and features this subject, product or style.",
  },
  {
    value: "start_frame",
    label: "Exact first frame",
    description: "The video opens on this exact image and continues from it.",
  },
];

/** Matches the server: below this nothing usable survives enlarging. */
export const MIN_VIDEO_SOURCE_EDGE = 16;
/** Video models reject smaller inputs; the server enlarges and pads up to this. */
export const RECOMMENDED_VIDEO_SOURCE_EDGE = 720;

export function checkVideoSourceImageSize(size: { width: number; height: number } | null): { error?: string; notice?: string } {
  if (!size || !size.width || !size.height) return {};
  const { width, height } = size;
  if (Math.min(width, height) < MIN_VIDEO_SOURCE_EDGE) {
    return { error: `This image is only ${width}×${height} px. Use an image at least ${MIN_VIDEO_SOURCE_EDGE} px on each side (720 px or larger works best).` };
  }
  if (Math.min(width, height) < RECOMMENDED_VIDEO_SOURCE_EDGE) {
    return { notice: `This image is ${width}×${height} px, smaller than video models accept. It will be enlarged and padded to ${RECOMMENDED_VIDEO_SOURCE_EDGE} px automatically. A larger image gives a sharper result.` };
  }
  return {};
}

export function readImageSize(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") { resolve(null); return; }
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/** Typical provider time for one clip, shown while a video is generating. */
export const VIDEO_GENERATION_ESTIMATE = "usually 1–3 minutes, sometimes up to 5";

export function videoGenerationProgressLabel(startedAt?: string | number | Date, now: number = Date.now()): string {
  const started = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(started)) return `Generating video — ${VIDEO_GENERATION_ESTIMATE}.`;
  const elapsedSeconds = Math.max(0, Math.round((now - started) / 1000));
  const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)} min ${elapsedSeconds % 60}s`;
  return elapsedSeconds > 300
    ? `Still generating video (${elapsed} so far). This is taking longer than usual; it will keep going in the background.`
    : `Generating video — ${elapsed} elapsed, ${VIDEO_GENERATION_ESTIMATE}.`;
}
