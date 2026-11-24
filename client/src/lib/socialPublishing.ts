import { composeSocialCaption } from '../../../shared/socialCaption';
import { creatorSessionScope } from './creator-session';

export type OrganicPublishPlatform = "instagram" | "facebook" | "youtube" | "linkedin";

export function instagramHashtagCount(caption: string): number {
  return (caption.replace(/https?:\/\/\S+/gi, '').match(/#[\p{L}\p{N}_]+/gu) || []).length;
}

export function socialCaptionMeter(platform: OrganicPublishPlatform, caption: string): string {
  if (platform === 'linkedin') return `${caption.length.toLocaleString('en-US')} / 3,000 characters`;
  if (platform === 'youtube') return `${new TextEncoder().encode(caption).length.toLocaleString('en-US')} / 5,000 UTF-8 bytes`;
  if (platform === 'instagram') return `${caption.length.toLocaleString('en-US')} / 2,200 characters · ${instagramHashtagCount(caption)} / 30 hashtags`;
  return `${caption.length.toLocaleString('en-US')} / 63,206 characters`;
}

export function instagramOptionsFor(postType: string, value: { altText?: string; locationId?: string; collaborators?: string[]; shareToFeed?: boolean; coverUrl?: string; thumbOffset?: string }) {
  if (postType === 'story') return undefined;
  return {
    locationId: value.locationId?.trim() || undefined,
    collaborators: value.collaborators?.length ? value.collaborators : undefined,
    ...(postType === 'post' ? { altText: value.altText?.trim() || undefined } : {}),
    ...(postType === 'reel' ? { coverUrl: value.coverUrl?.trim() || undefined, thumbOffset: value.thumbOffset ? Number(value.thumbOffset) : undefined, shareToFeed: value.shareToFeed ?? true } : {}),
  };
}

export function instagramReviewError(postType: string, value: Parameters<typeof instagramOptionsFor>[1]): string | null {
  const options = instagramOptionsFor(postType, value);
  if (!options) return null;
  if (options.locationId && !/^\d+$/.test(options.locationId)) return 'Instagram locations need a numeric Facebook Place ID.';
  if (options.collaborators && (options.collaborators.length > 3 || options.collaborators.some(name => !/^[A-Za-z0-9._]{1,30}$/.test(name)))) return 'Add up to three valid Instagram collaborator usernames, without @.';
  return null;
}

export type SocialPublishingAsset = {
  id: number;
  version?: number;
  publishingReviewToken?: string;
  title: string;
  content: string;
  type?: string;
  status?: string;
  channel?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  videoUrl?: string | null;
  videoUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

export function instagramReviewFromAsset(asset: SocialPublishingAsset): Parameters<typeof instagramOptionsFor>[1] & { coverUrl: string; thumbOffset: string } {
  const snapshot = asset.metadata?.reviewedPublishSnapshot as Record<string, unknown> | undefined;
  const options = (snapshot?.platform === 'instagram' ? snapshot.instagramOptions : asset.metadata?.instagramOptions) as Record<string, unknown> | undefined;
  if (!options) return { coverUrl: '', thumbOffset: '' };
  return { altText: typeof options.altText === 'string' ? options.altText : undefined, locationId: typeof options.locationId === 'string' ? options.locationId : undefined, collaborators: Array.isArray(options.collaborators) ? options.collaborators.filter((name): name is string => typeof name === 'string') : undefined, shareToFeed: typeof options.shareToFeed === 'boolean' ? options.shareToFeed : undefined, coverUrl: typeof options.coverUrl === 'string' ? options.coverUrl : '', thumbOffset: typeof options.thumbOffset === 'number' ? String(options.thumbOffset) : '' };
}

export function captionFromSocialAsset(asset: SocialPublishingAsset): string {
  try {
    const parsed = JSON.parse(asset.content) as Record<string, unknown>;
    if (typeof parsed === "string") return asset.type === "video" && /^(https?:\/\/|\/)/i.test(parsed) ? "" : parsed;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return asset.content || "";
    return composeSocialCaption({ ...parsed, caption: asset.type === 'video' || asset.channel === 'youtube' ? parsed.description ?? parsed.caption : parsed.caption ?? parsed.description });
  } catch {
    return asset.type === "video" && /^(https?:\/\/|\/)/i.test(asset.content) ? "" : asset.content || "";
  }
}

export function titleFromSocialAsset(asset: SocialPublishingAsset): string {
  try {
    const parsed: unknown = JSON.parse(asset.content);
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") return parsed.title;
  } catch { /* Plain-text content uses the saved asset title. */ }
  return asset.title || "";
}

// Reuse a reviewed request even after a modal is closed and reopened following a
// lost response. A changed payload is a new approval, never an uncertain retry.
const publishAttempts = new Map<string, string>();
export function publishingIdempotencyKey(scope: string, payload: unknown, initialKey?: string): string {
  const fingerprint = `${creatorSessionScope()}:${scope}:${JSON.stringify(payload)}`;
  let stored: Record<string, string> = {};
  try { stored = JSON.parse(sessionStorage.getItem('social-publishing-receipts') || '{}'); } catch { /* Private browsing may disable storage. */ }
  const existing = publishAttempts.get(fingerprint) || stored[fingerprint];
  if (existing) return existing;
  const key = initialKey || crypto.randomUUID();
  publishAttempts.set(fingerprint, key);
  try { sessionStorage.setItem('social-publishing-receipts', JSON.stringify({ ...stored, [fingerprint]: key })); } catch { /* In-memory protection remains available. */ }
  return key;
}

function timezoneParts(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function scheduledLocalValue(value: unknown, timezone: string): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try { return timezoneParts(date, timezone); } catch { return ""; }
}

/** Reject skipped and repeated DST wall times rather than silently moving a post. */
export function scheduleToISOString(local: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Choose a valid schedule date and time.");
  const reference = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(reference) || new Date(reference).toISOString().slice(0, 16) !== local) throw new Error("Choose a valid schedule date and time.");
  const offsets = new Set<number>();
  try {
    // Sample both sides of a possible offset transition, including half-hour DST.
    for (let hour = -36; hour <= 36; hour += 6) {
      const sample = reference + hour * 3_600_000;
      offsets.add(Date.parse(`${timezoneParts(new Date(sample), timezone)}:00Z`) - sample);
    }
  } catch { throw new Error("Choose a valid timezone before scheduling."); }
  const matches = [...offsets].map((offset) => reference - offset).filter((instant) => timezoneParts(new Date(instant), timezone) === local);
  if (!matches.length) throw new Error("This local time does not exist because the clocks change. Choose another time.");
  if (matches.length > 1) throw new Error("This local time occurs twice because the clocks change. Choose an unambiguous time.");
  return new Date(matches[0]).toISOString();
}

export function formatScheduledInstant(local: string, schedulingTimezone: string, displayTimezone = schedulingTimezone): string {
  if (!local) return "";
  const instant = new Date(scheduleToISOString(local, schedulingTimezone));
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: displayTimezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(instant);
  } catch {
    return "";
  }
}

export type PublishingOutcome = { success?: boolean; partialSuccess?: boolean; accepted?: boolean; scheduled?: boolean; error?: string; results?: Record<string, { success: boolean; status?: string; error?: string; postUrl?: string }> };
export function publishingStatusLabel(status?: string, scheduled = false) {
  return ({ pending: scheduled ? 'Scheduled' : 'Queued', claimed: 'Publishing', provider_succeeded: 'Uploaded; provider processing in progress', retryable_failed: 'Retrying automatically', ambiguous: 'Checking provider status', succeeded: 'Published', failed: 'Failed — review the error', cancelled: 'Cancelled', remote_deleted: 'Removed from provider' } as Record<string, string>)[status || ''] || status;
}
export function publishingFeedback(result: PublishingOutcome, scheduling: boolean) {
  const entries = Object.values(result.results || {});
  const pending = result.accepted || entries.some((entry) => ["pending", "claimed", "provider_succeeded", "retryable_failed"].includes(entry.status || ""));
  const failed = entries.some((entry) => !entry.success && !["pending", "claimed", "provider_succeeded", "retryable_failed"].includes(entry.status || ""));
  const accepted = Boolean(result.success || result.partialSuccess || pending || entries.some((entry) => entry.success));
  const publishedWarning = entries.some(entry => entry.success && entry.status === 'succeeded' && entry.error);
  return {
    accepted,
    warning: !accepted || failed || Boolean(result.partialSuccess) || publishedWarning,
    title: !accepted ? (scheduling ? "Scheduling failed" : "Publishing failed") : result.partialSuccess && !scheduling ? "Partially published" : failed ? "Some destinations need attention" : scheduling && result.scheduled ? "Post scheduled" : pending ? "Publishing in progress" : publishedWarning ? "Published with a setup warning" : result.success ? "Post published" : "Review publishing results",
    description: !accepted ? result.error || entries.find((entry) => entry.error)?.error || "The post was not accepted. Review the errors and retry." : failed || result.partialSuccess ? "Review each destination below. Open the calendar to recover only the destinations that need attention." : scheduling && result.scheduled ? "Saved for the selected time. It has not been published yet." : pending ? "Accepted for processing; publishing is not yet complete. Check the calendar for updated delivery status." : publishedWarning ? "Your post is published. Open the provider link to finish the optional settings mentioned below; do not publish it again." : "Review the destination results below.",
  };
}

/**
 * Formats that publish only the post's single video. A post that also carries
 * generated images (e.g. image + video from the Social creator) can still go
 * out as a Reel or video; the images stay on the draft. Mirrors the server's
 * `mediaForOrganicFormat` in OrganicPublishingService.
 */
export function isVideoOnlyFormat(platform: OrganicPublishPlatform, postType: string): boolean {
  return platform === "youtube"
    || (platform === "instagram" && postType === "reel")
    || (platform === "facebook" && postType === "video");
}

/** The media a format actually publishes (used for previews and validation). */
export function mediaForSocialFormat<T extends { imageUrls: string[]; videoUrls: string[] }>(platform: OrganicPublishPlatform, postType: string, media: T): { imageUrls: string[]; videoUrls: string[] } {
  if (media.videoUrls.length === 1 && media.imageUrls.length > 0 && isVideoOnlyFormat(platform, postType)) {
    return { imageUrls: [], videoUrls: media.videoUrls };
  }
  return { imageUrls: media.imageUrls, videoUrls: media.videoUrls };
}

export function recommendedSocialFormat(platform: OrganicPublishPlatform, images: number, videos: number): string {
  return socialFormatsFor(platform, images, videos)[0]?.value
    || (platform === "youtube" ? "video" : platform === "instagram" ? "post" : "text");
}

/**
 * Publishing formats offered for the saved media. The first entry is the
 * default: a single video defaults to Reel / video, never to Carousel.
 */
export function socialFormatsFor(platform: OrganicPublishPlatform, images: number, videos: number) {
  const withImages = images > 0 ? " · video only" : "";
  if (platform === 'linkedin') return images || videos ? [] : [{ value: 'text', label: 'LinkedIn text post' }];
  if (platform === "youtube") return videos === 1 ? [{ value: "video", label: `YouTube video${withImages}` }, { value: "short", label: `YouTube Short${withImages}` }] : [];
  if (platform === "instagram") return [
    ...(videos === 1 ? [{ value: "reel", label: `Instagram Reel${withImages}` }] : []),
    ...(images === 1 && videos === 0 ? [{ value: "post", label: "Instagram feed photo" }] : []),
    ...(images + videos === 1 ? [{ value: "story", label: "Instagram Story · no caption" }] : []),
    ...(images + videos >= 2 && images + videos <= 10 ? [{ value: "carousel", label: "Instagram carousel" }] : []),
  ];
  if (platform === "facebook") return [
    ...(videos === 1 ? [{ value: "video", label: `Facebook video${withImages}` }] : []),
    ...(!images && !videos ? [{ value: "text", label: "Facebook text post" }] : []),
    ...(images >= 1 && !videos ? [{ value: "photo", label: images > 1 ? "Facebook multi-photo post" : "Facebook photo post" }] : []),
  ];
  return [];
}

/** Why a destination has no publishing format for the saved media. */
export function noSocialFormatMessage(platform: OrganicPublishPlatform, images: number, videos: number): string {
  if (platform === "linkedin") return "LinkedIn publishing here supports text-only posts. Remove the media or choose another network.";
  if (platform === "youtube") return videos > 1 ? "YouTube needs exactly one video. Keep one video on this post." : "YouTube needs a saved video. Add or generate a video first.";
  if (videos > 1) return "Only one video can be published at a time. Keep one video on this post.";
  if (images + videos > 10) return "Instagram carousels accept at most 10 items. Remove some media.";
  return "This media combination cannot be published to this network.";
}

export function socialFormatDescription(platform: OrganicPublishPlatform, postType: string): string {
  if (platform === 'linkedin') return 'Publishes the reviewed text to the selected LinkedIn account. Native media upload is not implemented; media URLs are not appended to your copy.';
  if (platform === "instagram") {
    if (postType === "story") return "Publishes full-screen media to Stories. Meta does not accept a caption for this format.";
    if (postType === "carousel") return "Publishes the saved images and videos as one swipeable Instagram feed post.";
    if (postType === "reel") return "Publishes the saved video as an Instagram Reel with its reviewed caption.";
    return "Publishes the saved image to the Instagram feed with its reviewed caption.";
  }
  if (platform === "facebook") {
    if (postType === "video") return "Publishes the saved video to the selected Facebook Page.";
    if (postType === "text") return "Publishes the reviewed caption as a text post on the selected Facebook Page.";
    return "Publishes all saved images and the reviewed caption to the selected Facebook Page.";
  }
  return postType === "short"
    ? "Uploads the saved vertical video as a YouTube Short using the reviewed title and description."
    : "Uploads the saved video to the selected YouTube channel using the reviewed title and description.";
}
