import { useCallback, useEffect, useRef, useState } from "react";
import { socialInsightsGet } from "@/lib/socialInsightsApi";
import type { ContentItem } from "./SocialContentInsights";

export function previewSources(item: ContentItem): string[] {
  const image = (type: string, url?: string | null) => /video|reel/i.test(type) ? null : url;
  return [...new Set([
    item.thumbnailUrl,
    image(item.mediaType || item.type, item.mediaUrl),
    ...(item.children || []).flatMap(child => [child.thumbnailUrl, image(child.type, child.mediaUrl)]),
  ].filter((url): url is string => Boolean(url)))];
}

/** One recovery request per mounted post, never a loop against an expired URL. */
export function useSocialMedia(item: ContentItem, credentialId?: string) {
  const [fresh, setFresh] = useState<ContentItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const attempted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    setFresh(null);
    attempted.current = false;
    setRefreshing(false);
    generation.current++;
    return () => { generation.current++; };
  }, [item.id, item.mediaUrl, item.thumbnailUrl, credentialId]);
  const recover = useCallback(async () => {
    if (attempted.current || !credentialId || item.platform !== "instagram") return;
    attempted.current = true;
    const current = generation.current;
    setRefreshing(true);
    try {
      const query = new URLSearchParams({ credentialId, platform: item.platform, refreshMedia: "1" });
      const result = await socialInsightsGet<{ item: ContentItem }>(
        `/api/social-analytics/content/${encodeURIComponent(item.id)}?${query}`,
      );
      if (current === generation.current && result.item?.id === item.id) setFresh(result.item);
    } catch {
      // Keep the saved post usable when Meta cannot refresh its media.
    } finally {
      if (current === generation.current) setRefreshing(false);
    }
  }, [credentialId, item.id, item.platform]);
  return { media: fresh || item, recover, refreshing };
}
