export interface VideoCapabilities {
  aspectRatios?: string[];
  durations?: number[];
  resolutions?: string[];
  maxOutputs?: number;
}

export const GOOGLE_VIDEO_CAPABILITIES: VideoCapabilities = {
  aspectRatios: ['16:9', '9:16'], durations: [4, 6, 8], resolutions: ['720p', '1080p'], maxOutputs: 1,
};

/** Correct proposed settings before presenting the editable review. */
export function prepareVideoSettings(values: Record<string, unknown>, capabilities: VideoCapabilities, google = false) {
  const choose = <T,>(value: unknown, allowed: T[] | undefined, fallback: T) =>
    allowed?.length ? allowed.includes(value as T) ? value as T : allowed.includes(fallback) ? fallback : allowed[0] : value ?? fallback;
  const settings = {
    ...values,
    aspect_ratio: choose(values.aspect_ratio, capabilities.aspectRatios, '16:9'),
    resolution: choose(values.resolution, capabilities.resolutions, '720p'),
    duration_seconds: choose(values.duration_seconds, capabilities.durations, 8),
    number_of_videos: Math.min(Math.max(Number(values.number_of_videos) || 1, 1), capabilities.maxOutputs || 1),
  };
  if (google && settings.resolution === '1080p') settings.duration_seconds = 8;
  return settings;
}

/** Reject invalid reviewed settings before a paid provider request. */
export function validateVideoSettings(values: Record<string, unknown>, capabilities: VideoCapabilities, google = false): string | undefined {
  for (const [key, allowed] of [['aspect_ratio', capabilities.aspectRatios], ['resolution', capabilities.resolutions], ['duration_seconds', capabilities.durations]] as const) {
    if (values[key] != null && allowed?.length && !(allowed as readonly unknown[]).includes(values[key])) {
      return `Unsupported video ${key.replaceAll('_', ' ')}: ${values[key]}. Choose ${allowed.join(', ')} in the review.`;
    }
  }
  const count = values.number_of_videos;
  if (count != null && (!Number.isInteger(count) || Number(count) < 1 || Number(count) > (capabilities.maxOutputs || 1))) {
    return `Choose between 1 and ${capabilities.maxOutputs || 1} videos per request.`;
  }
  if (google && values.resolution === '1080p' && values.duration_seconds !== 8) return '1080p video requires an 8-second duration.';
}
