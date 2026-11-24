export type ContentMediaItem = { type: "image" | "video"; url: string };

type MediaValue = string | null | undefined | readonly (string | null | undefined)[];

export function uniqueMediaUrls(...values: MediaValue[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const url = candidate.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

export function buildContentMedia(options: {
  imageUrl?: string | null;
  imageUrls?: readonly (string | null | undefined)[] | null;
  videoUrl?: string | null;
  videoUrls?: readonly (string | null | undefined)[] | null;
}): { imageUrls: string[]; videoUrls: string[]; items: ContentMediaItem[] } {
  // Arrays preserve the user's carousel order. Singular fields are fallbacks
  // for older assets and are appended only when they are not already present.
  const imageUrls = uniqueMediaUrls(options.imageUrls, options.imageUrl);
  const videoUrls = uniqueMediaUrls(options.videoUrls, options.videoUrl);
  return {
    imageUrls,
    videoUrls,
    items: [
      ...imageUrls.map((url) => ({ type: "image" as const, url })),
      ...videoUrls.map((url) => ({ type: "video" as const, url })),
    ],
  };
}
