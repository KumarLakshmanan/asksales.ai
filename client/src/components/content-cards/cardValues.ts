/** Small value helpers shared by the content cards. */

/** A string field, or the `prompt` of an object field (for image/video prompt objects), else undefined. */
export const getStringValue = (val: unknown): string | undefined => {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && 'prompt' in val) return String((val as { prompt: unknown }).prompt);
  return undefined;
};

/** Where a media asset came from, as shown on the image and video cards. */
export const getSourceLabel = (type: string | undefined) => {
  switch (type?.toLowerCase()) {
    case "social_post":
      return "Social Post";
    case "ad_copy":
      return "Ad Campaign";
    case "social_dm":
      return "Social DM";
    default:
      return "Content Studio";
  }
};
