"use client";

import { deviceTimeZone } from "../../../../shared/timeZones";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Facebook,
  Linkedin,
  Instagram,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Youtube,
} from "lucide-react";
import api from "@/lib/api";
import { buildContentMedia } from "@/lib/contentMedia";
import { normalizeUploadUrl } from "@/lib/utils";
import { findUnresolvedTemplateTokens } from "@/utils/templateVariables";
import { useOrganicPublishingAccounts, type OrganicPublishingAccount } from "@/hooks/useOrganicPublishingAccounts";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  instagramOptionsFor,
  instagramReviewError,
  instagramReviewFromAsset,
  captionFromSocialAsset,
  instagramHashtagCount,
  socialCaptionMeter,
  titleFromSocialAsset,
  publishingIdempotencyKey,
  publishingFeedback,
  publishingStatusLabel,
  formatScheduledInstant,
  scheduleToISOString,
  recommendedSocialFormat,
  socialFormatDescription,
  socialFormatsFor,
  mediaForSocialFormat,
  noSocialFormatMessage,
  type OrganicPublishPlatform,
  type SocialPublishingAsset,
} from "@/lib/socialPublishing";
import { YouTubeReviewFields } from './YouTubeReviewFields';
import { youtubeReviewFromAsset, youtubeReviewError, youtubeTags, youtubeOptions, youtubeDescriptionPreview, YOUTUBE_SCHEDULE_HELP, type YouTubeReviewSettings } from '@/lib/youtubePublishing';
import { InstagramReviewFields, type InstagramReviewSettings } from "@/components/social-publishing/InstagramReviewFields";
import { DEFAULT_BUSINESS_TIMEZONE } from '@/lib/timezoneDefaults';
import { createGuardedRefresh } from '@/lib/guardedRefresh';
import { clearOrganicPublishIntent, loadOrganicPublishIntent, originalPublishContextMatches, recoveredPublishingResult, retainOrganicPublishIntent, type PendingOrganicPublish, type RecoveryAttempt } from '@/lib/organicPublishRecovery';

export type SocialPublishPlatform = OrganicPublishPlatform;
type ContentAsset = SocialPublishingAsset;

type TargetDraft = InstagramReviewSettings & {
  credentialId: number;
  caption: string;
  postType: string;
  title: string;
  coverUrl: string;
  thumbOffset: string;
};

type PublishResult = {
  success: boolean;
  partialSuccess?: boolean;
  accepted?: boolean;
  scheduled?: boolean;
  postUrl?: string;
  error?: string;
  results?: Record<string, { success: boolean; status?: string; postUrl?: string; error?: string; attemptId?: number; assetId?: number }>;
};

const platformMeta: Record<SocialPublishPlatform, { label: string; Icon: typeof Instagram; accent: string; soft: string; route: string }> = {
  linkedin: { label: "LinkedIn", Icon: Linkedin, accent: "bg-[#0A66C2]", soft: "bg-blue-500/8 text-blue-700 dark:text-blue-300", route: "/dashboard/integrations" },
  instagram: { label: "Instagram", Icon: Instagram, accent: "bg-gradient-to-br from-fuchsia-600 via-pink-500 to-orange-400", soft: "bg-pink-500/8 text-pink-700 dark:text-pink-300", route: "/dashboard/integrations/instagram" },
  facebook: { label: "Facebook", Icon: Facebook, accent: "bg-[#1877F2]", soft: "bg-blue-500/8 text-blue-700 dark:text-blue-300", route: "/dashboard/integrations/facebook" },
  youtube: { label: "YouTube", Icon: Youtube, accent: "bg-red-600", soft: "bg-red-500/8 text-red-700 dark:text-red-300", route: "/dashboard/integrations/youtube" },
};

function Preview({ platform, caption, asset, postType, accountName, title, visibility }: { platform: SocialPublishPlatform; caption: string; asset: ContentAsset; postType: string; accountName: string; title: string; visibility: string }) {
  // Show exactly what this format publishes (a Reel shows only its video).
  const media = buildContentMedia(mediaForSocialFormat(platform, postType, buildContentMedia(asset)));
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [platform, asset.id, postType]);
  const item = media.items[index] || media.items[0];
  const { Icon, label, accent } = platformMeta[platform];

  return (
    <div className="relative mx-auto w-full max-w-[390px] overflow-hidden rounded-[28px] border border-border/70 bg-card shadow-[0_24px_70px_-36px_rgba(15,23,42,.55)]">
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3.5">
        <div className={cn("grid h-10 w-10 place-items-center rounded-2xl text-white shadow-sm", accent)}><Icon className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{accountName || "Connected account"}</p><p className="text-xs text-muted-foreground">{label} · {postType.replace(/\b\w/g, (letter) => letter.toUpperCase())}</p></div>
        <Badge variant="outline" className="rounded-full bg-background text-[10px]">Draft</Badge>
      </div>
      {item ? (
        <div className={cn("relative overflow-hidden bg-muted", postType === "story" || postType === "short" ? "aspect-[9/16]" : platform === "youtube" ? "aspect-video" : "aspect-square")}>
          {item.type === "image" ? <img src={normalizeUploadUrl(item.url)} alt="Post media preview" className="h-full w-full object-contain" /> : <video src={normalizeUploadUrl(item.url)} controls className="h-full w-full object-cover" />}
          {media.items.length > 1 && <>
            <button type="button" onClick={() => setIndex((current) => current === 0 ? media.items.length - 1 : current - 1)} className="absolute left-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur" aria-label="Previous media"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => setIndex((current) => current === media.items.length - 1 ? 0 : current + 1)} className="absolute right-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur" aria-label="Next media"><ChevronRight className="h-4 w-4" /></button>
            <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2 py-1 text-[10px] font-semibold text-white">{index + 1}/{media.items.length}</span>
          </>}
        </div>
      ) : <div className="grid aspect-[16/10] place-items-center bg-[radial-gradient(circle_at_20%_10%,hsl(var(--primary)/.16),transparent_42%),hsl(var(--muted)/.55)]"><div className="text-center"><Sparkles className="mx-auto h-6 w-6 text-primary" /><p className="mt-2 text-xs font-medium text-muted-foreground">Text-first post</p></div></div>}
      <div className="space-y-3 px-4 py-4">
        {platform === 'youtube' && <><h4 className="font-semibold">{title || 'Video title'}</h4><Badge variant="outline">{visibility}</Badge></>}
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{caption || "Your reviewed caption will appear here."}</p>
        <div className="flex items-center justify-between border-t border-border/50 pt-3 text-[11px] text-muted-foreground"><span>Provider engagement appears after publishing</span><ShieldCheck className="h-3.5 w-3.5" /></div>
      </div>
    </div>
  );
}

export function SocialPublisher({ assetId, open, onOpenChange, onPublished, initialPlatform, initialPlatforms, initialScheduledDate, initialCaption }: { assetId: number; open: boolean; onOpenChange: (open: boolean) => void; onPublished?: (result?: PublishResult) => void; initialPlatform?: SocialPublishPlatform; initialPlatforms?: SocialPublishPlatform[]; initialScheduledDate?: string; initialCaption?: string }) {
  const { toast } = useToast();
  const {
    accounts: connectedAccounts,
    loading: accountsLoading,
    error: accountsError,
  } = useOrganicPublishingAccounts();
  const [asset, setAsset] = useState<ContentAsset | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState<SocialPublishPlatform[]>([]);
  const [activePlatform, setActivePlatform] = useState<SocialPublishPlatform>("instagram");
  const [sharedCaption, setSharedCaption] = useState("");
  const [customize, setCustomize] = useState(false);
  const [targets, setTargets] = useState<Record<SocialPublishPlatform, TargetDraft>>({
    linkedin: { credentialId: 0, caption: "", postType: "text", title: "", coverUrl: "", thumbOffset: "" },
    instagram: { credentialId: 0, caption: "", postType: "post", title: "", coverUrl: "", thumbOffset: "" },
    facebook: { credentialId: 0, caption: "", postType: "text", title: "", coverUrl: "", thumbOffset: "" },
    youtube: { credentialId: 0, caption: "", postType: "video", title: "", coverUrl: "", thumbOffset: "" },
  });
  const [youtube, setYoutube] = useState<YouTubeReviewSettings>({ privacyStatus: 'private', tags: '' });
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<PendingOrganicPublish | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [canReviewLatest, setCanReviewLatest] = useState(false);
  const recoveryEpoch = useRef(0);
  const publishingRef = useRef(false);
  const [timezone, setTimezone] = useState(DEFAULT_BUSINESS_TIMEZONE);
  const deviceTimezone = useMemo(() => deviceTimeZone(DEFAULT_BUSINESS_TIMEZONE), []);
  const [timezoneLoading, setTimezoneLoading] = useState(false);

  useEffect(() => {
    if (!open || !result || result.scheduled || !Object.values(result.results || {}).some(entry => ['pending', 'claimed', 'provider_succeeded', 'retryable_failed', 'ambiguous'].includes(entry.status || ''))) return;
    let cancelled = false;
    const refresh = async () => {
      const assetIds = [...new Set(Object.values(result.results || {}).map(entry => entry.assetId || assetId))];
      const responses = await Promise.allSettled(assetIds.map(id => api.get<{ attempts: Array<{ id: number; platform: string; status: string; errorMessage?: string; providerPostUrl?: string }> }>(`/api/content/assets/${id}/publish-attempts`)));
      if (cancelled) return;
      const attempts = responses.flatMap(response => response.status === 'fulfilled' ? Array.isArray(response.value.attempts) ? response.value.attempts : [] : []);
      setResult(current => {
        if (!current?.results) return current;
        const results = { ...current.results };
        for (const [platform, entry] of Object.entries(results)) {
          const attempt = attempts.find(attempt => attempt.id === entry.attemptId);
          if (attempt) results[platform] = { ...entry, status: attempt.status, success: attempt.status === 'succeeded', error: attempt.errorMessage || undefined, postUrl: attempt.providerPostUrl || entry.postUrl };
        }
        const values = Object.values(results);
        const success = values.every(entry => entry.success);
        const accepted = values.some(entry => ['pending', 'claimed', 'provider_succeeded', 'retryable_failed'].includes(entry.status || ''));
        return { ...current, results, success, accepted, partialSuccess: !success && values.some(entry => entry.success) };
      });
    };
    // Ticks skip hidden tabs and never overlap a status read still running.
    const guard = createGuardedRefresh(refresh);
    const timer = window.setInterval(guard.poll, 5000);
    return () => { cancelled = true; guard.stop(); window.clearInterval(timer); };
  }, [open, result, assetId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fallback = DEFAULT_BUSINESS_TIMEZONE;
    setTimezoneLoading(true);
    api.get<{ timezone?: string; preferences?: { timezone?: string } }>('/api/settings/preferences')
      .then(value => { if (!cancelled) setTimezone(value.timezone || value.preferences?.timezone || fallback); })
      .catch(() => { if (!cancelled) setTimezone(fallback); })
      .finally(() => { if (!cancelled) setTimezoneLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    ++recoveryEpoch.current;
    if (!open || !assetId) return;
    let cancelled = false;
    setAssetLoading(true); setAssetError(null); setResult(null); setAsset(null);
    setPublishError(null); setSharedCaption(""); setCustomize(false);
    setSelectedPlatforms([]); setActivePlatform("instagram");
    setScheduleEnabled(Boolean(initialScheduledDate)); setScheduledFor(initialScheduledDate?.length === 10 ? `${initialScheduledDate}T12:00` : initialScheduledDate || "");
    setYoutube({ privacyStatus: 'private', tags: '' });
    setTargets({
      linkedin: { credentialId: 0, caption: "", postType: "text", title: "", coverUrl: "", thumbOffset: "" },
      instagram: { credentialId: 0, caption: "", postType: "post", title: "", coverUrl: "", thumbOffset: "" },
      facebook: { credentialId: 0, caption: "", postType: "text", title: "", coverUrl: "", thumbOffset: "" },
      youtube: { credentialId: 0, caption: "", postType: "video", title: "", coverUrl: "", thumbOffset: "" },
    });
    const previous = loadOrganicPublishIntent(assetId);
    setCanReviewLatest(false);
    setPendingRecovery(previous); setRecoveryLoading(Boolean(previous));
    const receipt = previous ? api.get<{ attempts: RecoveryAttempt[] }>(`/api/content/assets/${assetId}/publish-attempts`, { params: { requestKey: previous.key } }) : Promise.resolve(null);
    Promise.allSettled([api.get<ContentAsset>(`/api/content/assets/${assetId}`), receipt] as const).then(([saved, recovered]) => {
      if (cancelled) return;
      if (saved.status === 'rejected') throw saved.reason;
      const value = saved.value;
      setAsset(value);
      const caption = initialCaption ?? captionFromSocialAsset(value);
      setSharedCaption(caption);
      setYoutube(youtubeReviewFromAsset(value));
      setTargets((current) => ({
        ...current,
        linkedin: { ...current.linkedin, caption },
        instagram: { ...current.instagram, ...instagramReviewFromAsset(value), caption }, facebook: { ...current.facebook, caption },
        youtube: { ...current.youtube, caption, title: titleFromSocialAsset(value) },
      }));
      if (previous) {
        if (recovered.status === 'fulfilled' && recovered.value) {
          setCanReviewLatest(Array.isArray(recovered.value.attempts) && recovered.value.attempts.length === 0);
          const restored = recoveredPublishingResult(previous, Array.isArray(recovered.value.attempts) ? recovered.value.attempts : []);
          if (restored) {
            setSelectedPlatforms(previous.payload.targets.map(target => target.platform));
            setScheduleEnabled(Boolean(previous.payload.scheduledFor));
            setResult(restored);
          }
        } else setPublishError('The previous publication could not be checked. Keep this review while checking its status.');
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setAssetError(reason instanceof Error ? reason.message : "The post could not be loaded.");
    }).finally(() => { if (!cancelled) { setAssetLoading(false); setRecoveryLoading(false); } });
    return () => { cancelled = true; };
  }, [assetId, open, initialScheduledDate, initialCaption]);

  const media = useMemo(() => buildContentMedia(asset || {}), [asset]);
  const availablePlatforms = useMemo(
    () => (["instagram", "facebook", "youtube", "linkedin"] as const).filter((platform) => connectedAccounts.some((account) => account.platform === platform)),
    [connectedAccounts],
  );

  useEffect(() => {
    if (!open || accountsLoading || !asset || result || pendingRecovery || recoveryLoading) return;
    setTargets((current) => {
      const next = { ...current };
      for (const platform of availablePlatforms) {
        const platformAccounts = connectedAccounts.filter((account) => account.platform === platform);
        const preferred = platformAccounts.find((account) => account.isSelected) || (platformAccounts.length === 1 ? platformAccounts[0] : undefined);
        const formats = socialFormatsFor(platform, media.imageUrls.length, media.videoUrls.length);
        const currentCredentialIsConnected = platformAccounts.some((account) => account.credentialId === next[platform].credentialId);
        next[platform] = { ...next[platform], credentialId: currentCredentialIsConnected ? next[platform].credentialId : preferred?.credentialId || 0, postType: formats.some((format) => format.value === next[platform].postType) ? next[platform].postType : formats[0]?.value || recommendedSocialFormat(platform, media.imageUrls.length, media.videoUrls.length) };
      }
      return next;
    });
    setSelectedPlatforms((current) => {
      const stillAvailable = current.filter((platform) => availablePlatforms.includes(platform));
      if (stillAvailable.length) return stillAvailable;
      const requestedPlatforms = initialPlatforms?.filter(platform => availablePlatforms.includes(platform));
      if (requestedPlatforms?.length) return requestedPlatforms;
      const requested = initialPlatform || (asset.type === 'video' && availablePlatforms.includes('youtube') ? 'youtube' : String(asset.channel || "").toLowerCase()) as SocialPublishPlatform;
      return [availablePlatforms.includes(requested) ? requested : availablePlatforms[0]].filter(Boolean) as SocialPublishPlatform[];
    });
  }, [open, accountsLoading, asset, media.imageUrls.length, media.videoUrls.length, availablePlatforms, connectedAccounts, initialPlatform, initialPlatforms, result, pendingRecovery, recoveryLoading]);

  useEffect(() => {
    if (!selectedPlatforms.includes(activePlatform) && selectedPlatforms[0]) setActivePlatform(selectedPlatforms[0]);
  }, [selectedPlatforms, activePlatform]);

  const activeCaption = customize ? targets[activePlatform].caption : sharedCaption;
  const activeAccountName = connectedAccounts.find((account) => account.credentialId === targets[activePlatform].credentialId)?.accountName || "Connected account preview";
  const updateTarget = (platform: SocialPublishPlatform, update: Partial<TargetDraft>) => setTargets((current) => ({ ...current, [platform]: { ...current[platform], ...update } }));
  const captionLabel = customize
    ? activePlatform === "youtube" ? "YouTube description" : `${platformMeta[activePlatform].label} caption`
    : selectedPlatforms.length > 1 && selectedPlatforms.includes("youtube")
      ? "Shared caption and video description"
      : selectedPlatforms.length > 1 ? "Shared caption" : activePlatform === "youtube" ? "YouTube description" : "Caption";
  const changePostType = (platform: SocialPublishPlatform, postType: string) => {
    if (platform === "instagram" && postType === "story" && (customize ? targets.instagram.caption : sharedCaption).trim()) {
      if (selectedPlatforms.length > 1) {
        setTargets((current) => ({
          ...current,
          linkedin: { ...current.linkedin, caption: customize ? current.linkedin.caption : sharedCaption },
          instagram: { ...current.instagram, caption: "", postType },
          facebook: { ...current.facebook, caption: customize ? current.facebook.caption : sharedCaption },
          youtube: { ...current.youtube, caption: customize ? current.youtube.caption : sharedCaption },
        }));
        setCustomize(true);
      } else {
        setSharedCaption("");
        updateTarget(platform, { postType, caption: "" });
      }
      return;
    }
    updateTarget(platform, { postType });
  };
  const togglePlatform = (platform: SocialPublishPlatform) => {
    if (publishingRef.current) return;
    setSelectedPlatforms((current) => current.includes(platform) ? (current.length === 1 ? current : current.filter((value) => value !== platform)) : [...current, platform]);
    setActivePlatform(platform);
  };

  const validationError = useMemo(() => {
    if (!asset || selectedPlatforms.length === 0) return "Select at least one connected destination.";
    if (!asset.version || !asset.publishingReviewToken) return "Reload the saved content to review its latest version before publishing.";
    for (const platform of selectedPlatforms) {
      const target = targets[platform];
      if (platform === "instagram") { const error = instagramReviewError(target.postType, target); if (error) return error; }
      if (!target.credentialId) return `Choose a ${platformMeta[platform].label} account.`;
      const caption = customize ? target.caption : sharedCaption;
      if (findUnresolvedTemplateTokens(target.title, caption).length) return "Resolve every template variable before publishing.";
      if (platform === "instagram" && instagramHashtagCount(caption) > 30) return "Instagram captions support at most 30 hashtags.";
      if (platform === "instagram" && caption.length > 2200) return "Instagram captions support at most 2,200 characters.";
      if (platform === "linkedin" && (!caption.trim() || caption.length > 3000)) return "LinkedIn text must contain 1–3,000 characters.";
      if (platform === "facebook" && caption.length > 63206) return "Facebook posts support at most 63,206 characters.";
      if (platform === 'youtube') {
        if (media.videoUrls.length !== 1 || media.imageUrls.length) return 'YouTube requires exactly one saved video and no images.';
        if (!target.title.trim() || target.title.length > 100) return 'YouTube requires a title of 1–100 characters.';
        if (/[<>]/.test(target.title)) return 'YouTube titles cannot contain < or >.';
        if (new TextEncoder().encode(youtubeDescriptionPreview(caption, youtube.chapters)).length > 5000 || /[<>]/.test(caption)) return 'YouTube descriptions support at most 5,000 UTF-8 bytes and cannot contain < or >.';
        if (findUnresolvedTemplateTokens(youtube.tags).length) return 'Resolve every template variable in YouTube tags before publishing.';
        const youtubeError = youtubeReviewError(youtube);
        if (youtubeError) return youtubeError;
      }
      if (platform === "instagram" && target.postType === "story" && caption.trim()) return "Instagram Stories in this integration cannot include a caption. Clear the Instagram override or choose another format.";
      if (platform === "instagram" && target.postType === "reel" && target.coverUrl.trim() && !/^https:\/\//i.test(target.coverUrl.trim())) return "Instagram Reel covers must use HTTPS.";
      if (platform === "instagram" && target.postType === "reel" && target.thumbOffset && (!Number.isFinite(Number(target.thumbOffset)) || Number(target.thumbOffset) < 0)) return "Instagram thumbnail offset must be zero or greater.";
      if (!socialFormatsFor(platform, media.imageUrls.length, media.videoUrls.length).some((format) => format.value === target.postType)) return `${platformMeta[platform].label} cannot publish this saved media in the selected format.`;
    }
    if (scheduleEnabled) {
      if (timezoneLoading) return 'Loading your scheduling timezone.';
      try {
        if (Date.parse(scheduleToISOString(scheduledFor, timezone)) <= Date.now() + 60_000) return "Choose a schedule at least one minute in the future.";
      } catch (error) { return error instanceof Error ? error.message : "Choose a valid schedule."; }
    }
    return null;
  }, [asset, selectedPlatforms, targets, customize, sharedCaption, media.imageUrls.length, media.videoUrls.length, scheduleEnabled, scheduledFor, timezone, timezoneLoading, youtube]);
  const scheduledAccountTime = useMemo(() => {
    if (!scheduleEnabled || !scheduledFor) return "";
    try { return formatScheduledInstant(scheduledFor, timezone); } catch { return ""; }
  }, [scheduleEnabled, scheduledFor, timezone]);
  const scheduledDeviceTime = useMemo(() => {
    if (!scheduleEnabled || !scheduledFor || deviceTimezone === timezone) return "";
    try {
      const deviceTime = formatScheduledInstant(scheduledFor, timezone, deviceTimezone);
      return deviceTime === scheduledAccountTime ? "" : deviceTime;
    } catch { return ""; }
  }, [deviceTimezone, scheduleEnabled, scheduledFor, scheduledAccountTime, timezone]);

  const publish = async () => {
    if (publishingRef.current) return;
    if (validationError || !asset) { if (validationError) toast({ title: "Review publishing settings", description: validationError, variant: "destructive" }); return; }
    publishingRef.current = true;
    setPublishError(null);
    setPublishing(true);
    try {
      const payload = {
        expectedVersion: asset.version,
        expectedReviewToken: asset.publishingReviewToken,
        targets: selectedPlatforms.map((platform) => ({
          platform,
          credentialId: targets[platform].credentialId,
          caption: customize ? targets[platform].caption : sharedCaption,
          postType: targets[platform].postType,
          title: targets[platform].title || undefined,
          ...(platform === 'youtube' ? { tags: youtubeTags(youtube.tags), privacyStatus: youtube.privacyStatus, youtubeOptions: youtubeOptions(youtube) } : {}),
          instagramOptions: platform === "instagram" ? instagramOptionsFor(targets.instagram.postType, targets.instagram) : undefined,
        })),
        scheduledFor: scheduleEnabled ? scheduleToISOString(scheduledFor, timezone) : undefined,
        timezone,
      };
      if (payload.scheduledFor && Date.parse(payload.scheduledFor) <= Date.now() + 60_000) throw new Error("Choose a schedule at least one minute in the future.");
      const key = publishingIdempotencyKey(`asset:${asset.id}`, payload);
      retainOrganicPublishIntent(asset.id, key, payload);
      const response = await api.post<PublishResult>(`/api/content/assets/${asset.id}/publish`, payload, { headers: { "Idempotency-Key": key } });
      setResult(response);
      setPendingRecovery(null);
      const feedback = publishingFeedback(response, scheduleEnabled);
      if (feedback.accepted) onPublished?.(response);
      toast({ title: feedback.title, description: feedback.description, variant: feedback.warning ? "destructive" : "default" });
    } catch (reason) {
      const previous = loadOrganicPublishIntent(assetId);
      const code = (reason as { data?: { code?: string } })?.data?.code;
      if (code && ['CONTENT_VERSION_CONFLICT','SOURCE_REVIEW_REQUIRED','INVALID_VERSION','INVALID_SOURCE_REVIEW'].includes(code)) {
        if (previous) clearOrganicPublishIntent(previous);
        setPendingRecovery(null);
      } else setPendingRecovery(previous);
      const message = reason instanceof Error ? reason.message : "Review the destination settings and try again.";
      setPublishError(`${message} If the response was interrupted, retry unchanged settings to check the same publishing request safely.`);
      toast({ title: "Publishing request needs attention", description: message, variant: "destructive" });
    } finally { publishingRef.current = false; setPublishing(false); }
  };


  const checkPrevious = async () => {
    if (!pendingRecovery || !originalPublishContextMatches(pendingRecovery)) return;
    const epoch = recoveryEpoch.current;
    setRecoveryLoading(true); setPublishError(null);
    try {
      const response = await api.get<{ attempts: RecoveryAttempt[] }>(`/api/content/assets/${assetId}/publish-attempts`, { params: { requestKey: pendingRecovery.key } });
      if (epoch !== recoveryEpoch.current) return;
      setCanReviewLatest(Array.isArray(response.attempts) && response.attempts.length === 0);
      const restored = recoveredPublishingResult(pendingRecovery, Array.isArray(response.attempts) ? response.attempts : []);
      if (restored) { setSelectedPlatforms(pendingRecovery.payload.targets.map(target => target.platform)); setScheduleEnabled(Boolean(pendingRecovery.payload.scheduledFor)); setResult(restored); }
      else setPublishError('No saved receipt was found for this review. Retry the original request to check it safely.');
    } catch (reason) {
      if (epoch === recoveryEpoch.current) setPublishError(reason instanceof Error ? reason.message : 'The previous publication could not be checked.');
    } finally { if (epoch === recoveryEpoch.current) setRecoveryLoading(false); }
  };

  const retryOriginal = async () => {
    if (!pendingRecovery || publishingRef.current) return;
    if (!originalPublishContextMatches(pendingRecovery)) { setPublishError('The business context changed. Reload before continuing.'); return; }
    const epoch = recoveryEpoch.current;
    publishingRef.current = true; setPublishing(true); setPublishError(null);
    try {
      const response = await api.post<PublishResult>(`/api/content/assets/${assetId}/publish`, pendingRecovery.payload, { headers: { 'Idempotency-Key': pendingRecovery.key } });
      if (epoch !== recoveryEpoch.current) return;
      setSelectedPlatforms(pendingRecovery.payload.targets.map(target => target.platform));
      setScheduleEnabled(Boolean(pendingRecovery.payload.scheduledFor)); setResult(response); setPendingRecovery(null);
      if (publishingFeedback(response, Boolean(pendingRecovery.payload.scheduledFor)).accepted) onPublished?.(response);
    } catch (reason) {
      if (epoch !== recoveryEpoch.current) return;
      const code = (reason as { data?: { code?: string } })?.data?.code;
      if (code && ['CONTENT_VERSION_CONFLICT','SOURCE_REVIEW_REQUIRED','INVALID_VERSION','INVALID_SOURCE_REVIEW'].includes(code)) {
        clearOrganicPublishIntent(pendingRecovery); setPendingRecovery(null);
      }
      setPublishError(reason instanceof Error ? reason.message : 'The original publication could not be confirmed.');
    } finally { publishingRef.current = false; setPublishing(false); }
  };

  const reviewAgain = () => {
    const previous = pendingRecovery || loadOrganicPublishIntent(assetId);
    const safe = Object.values(result?.results || {}).every(entry => ['failed','cancelled','remote_deleted'].includes(entry.status || ''));
    if (safe && previous) clearOrganicPublishIntent(previous);
    setPendingRecovery(safe ? null : previous); setResult(null);
  };

  const reviewLatest = () => {
    if (!canReviewLatest || !pendingRecovery || !originalPublishContextMatches(pendingRecovery)) return;
    // This is a new explicit review, never an automatic retry. The server's
    // family lock and active-attempt guard still fence an overlapping request.
    clearOrganicPublishIntent(pendingRecovery); setPendingRecovery(null); setPublishError(null); setCanReviewLatest(false);
  };

  const body = assetLoading || recoveryLoading ? <LoadingState size="section" label="Loading post…" className="min-h-0 flex-1 basis-[min(520px,65dvh)]" />
    : assetError || !asset ? <div className="grid min-h-0 flex-1 basis-[min(520px,65dvh)] overflow-y-auto overscroll-contain place-items-center p-8 text-center"><div><AlertCircle className="mx-auto h-8 w-8 text-destructive" /><h3 className="mt-3 font-semibold">Post unavailable</h3><p className="mt-1 text-sm text-muted-foreground">{assetError || "This post no longer exists."}</p></div></div>
      : pendingRecovery && !result ? <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <h3 className="text-xl font-semibold">Check previous publication</h3>
          <p className="text-sm text-muted-foreground">This reviewed request has not been confirmed in this tab. Check its saved status or retry the same review before starting another publication.</p>
          <div className="space-y-3 rounded-lg border p-4">{pendingRecovery.payload.targets.map(target => <div key={target.platform}><h4 className="text-sm font-semibold">{platformMeta[target.platform].label}</h4><p className="whitespace-pre-wrap break-words text-sm">{target.caption}</p></div>)}</div>
          {publishError && <p role="alert" className="text-sm text-destructive">{publishError}</p>}
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={publishing} onClick={() => void checkPrevious()}>Check previous request</Button><Button disabled={publishing} onClick={() => void retryOriginal()}>{publishing ? 'Checking…' : 'Retry original request'}</Button>{canReviewLatest && <Button variant="outline" disabled={publishing} onClick={reviewLatest}>Review latest draft</Button>}<Button asChild variant="outline"><Link href="/dashboard/content-calendar">View status in calendar</Link></Button></div>
        </div>
          : result ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6"><div className="w-full max-w-lg"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-muted text-foreground">{publishingFeedback(result, scheduleEnabled).warning ? <AlertCircle className="h-7 w-7 text-destructive" /> : result.accepted ? <Spinner size="lg" label={null} /> : <Check className="h-7 w-7" />}</div><h3 className="mt-4 text-center text-xl font-semibold">{publishingFeedback(result, scheduleEnabled).title}</h3><p className="mt-2 text-center text-sm text-muted-foreground">{publishingFeedback(result, scheduleEnabled).description}</p><div className="mt-6 space-y-2">{selectedPlatforms.map((platform) => { const entry = result.results?.[platform]; return <div key={platform} className="flex items-center gap-3 rounded-xl border bg-card p-3"><div className={cn("grid h-9 w-9 place-items-center rounded-xl text-white", platformMeta[platform].accent)}>{(() => { const Icon = platformMeta[platform].Icon; return <Icon className="h-4 w-4" />; })()}</div><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{platformMeta[platform].label}</p><p className={cn("break-words text-xs", entry?.success ? "text-emerald-600" : "text-muted-foreground")}>{entry?.error || publishingStatusLabel(entry?.status, result.scheduled) || (entry?.success ? (result.scheduled ? "Scheduled" : "Published") : result.accepted ? "Processing" : "Not accepted")}</p></div>{entry?.postUrl && <a href={entry.postUrl} target="_blank" rel="noreferrer" className="text-primary"><ExternalLink className="h-4 w-4" /></a>}</div>; })}</div><div className="mt-6 flex justify-center gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button><Button asChild><Link href="/dashboard/content-calendar">View status in calendar</Link></Button>{!publishingFeedback(result, scheduleEnabled).accepted && <Button onClick={reviewAgain}>Review again</Button>}</div></div></div>
      : accountsLoading ? <LoadingState size="section" label="Loading connected accounts…" className="min-h-0 flex-1 basis-[min(520px,65dvh)]" />
        : accountsError && availablePlatforms.length === 0 ? <div className="grid min-h-0 flex-1 basis-[min(520px,65dvh)] overflow-y-auto overscroll-contain place-items-center p-8 text-center"><div className="max-w-sm"><AlertCircle className="mx-auto h-8 w-8 text-destructive" /><h3 className="mt-4 text-lg font-semibold">Publishing accounts unavailable</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{accountsError}</p><Button variant="outline" className="mt-5" onClick={() => window.location.reload()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></div></div>
        : availablePlatforms.length === 0 ? <div className="grid min-h-0 flex-1 basis-[min(520px,65dvh)] overflow-y-auto overscroll-contain place-items-center p-8 text-center"><div className="max-w-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border bg-muted/30"><Send className="h-6 w-6 text-primary" /></div><h3 className="mt-4 text-lg font-semibold">Connect a publishing account</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Connect Facebook, Instagram, YouTube, or LinkedIn before publishing this post.</p><Button asChild className="mt-5"><Link href="/dashboard/integrations">Connect social accounts <ExternalLink className="ml-2 h-4 w-4" /></Link></Button></div></div>
            : <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="social-publisher-scroll-region">
                <div className="grid min-h-full grid-cols-1 lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,.92fr)]">
                  <div className="border-b border-border/60 lg:border-b-0 lg:border-r">
                    <div className="border-b border-border/60 bg-muted/15 px-5 py-4">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted-foreground">Publish to</p>
                      <div className="flex flex-wrap items-center gap-2">{availablePlatforms.map((platform) => { const selected = selectedPlatforms.includes(platform); const platformAccounts = connectedAccounts.filter((account) => account.platform === platform); const preferred = platformAccounts.find((account) => account.isSelected) || (platformAccounts.length === 1 ? platformAccounts[0] : undefined); const { Icon, label, accent } = platformMeta[platform]; return <button type="button" key={platform} aria-pressed={selected} aria-label={`${label} ${preferred?.accountName || "connected account"}`} onClick={() => togglePlatform(platform)} className={cn("group flex items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-all", selected ? "border-primary/45 bg-primary/5 shadow-sm" : "border-border/60 bg-background hover:border-border")}><span className={cn("grid h-8 w-8 place-items-center rounded-xl text-white", accent)}><Icon className="h-4 w-4" /></span><span><span className="block text-xs font-semibold">{label}</span><span className="block max-w-32 truncate text-[10px] text-muted-foreground">{preferred?.accountName || "Connected"}</span></span>{selected && <Check className="ml-1 h-3.5 w-3.5 text-primary" />}</button>; })}</div>
                    </div>
                    <fieldset disabled={publishing} className="space-y-5 p-5">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2"><Label htmlFor="shared-caption">{captionLabel}</Label><div className="flex items-center gap-2"><Label htmlFor="customize-copy" className="text-xs font-normal text-muted-foreground">Different caption for each network</Label><Switch id="customize-copy" checked={customize} onCheckedChange={(enabled) => { if (enabled) setTargets((current) => ({ ...current, linkedin: { ...current.linkedin, caption: sharedCaption }, instagram: { ...current.instagram, caption: sharedCaption }, facebook: { ...current.facebook, caption: sharedCaption }, youtube: { ...current.youtube, caption: sharedCaption } })); setCustomize(enabled); }} /></div></div>
                        {customize && <div className="flex flex-wrap gap-1.5" aria-label="Caption destination">{selectedPlatforms.map((platform) => <Button key={platform} type="button" size="sm" variant={activePlatform === platform ? "secondary" : "ghost"} className="h-7 rounded-full px-3 text-xs" onClick={() => setActivePlatform(platform)}>{platformMeta[platform].label}</Button>)}</div>}
                        <Textarea id="shared-caption" rows={5} value={activeCaption} onChange={(event) => customize ? updateTarget(activePlatform, { caption: event.target.value }) : setSharedCaption(event.target.value)} placeholder={activePlatform === "youtube" ? "Write the reviewed video description…" : "Write the reviewed caption…"} />
                        <div className="flex justify-between text-[11px] text-muted-foreground"><span>{customize ? `Editing ${platformMeta[activePlatform].label}` : selectedPlatforms.length > 1 ? `Used for ${selectedPlatforms.map((platform) => platformMeta[platform].label).join(" and ")}` : `Used for ${platformMeta[activePlatform].label}`}</span><span>{socialCaptionMeter(activePlatform, activePlatform === "youtube" ? youtubeDescriptionPreview(activeCaption, youtube.chapters) : activeCaption)}</span></div>
                      </div>

                      <div className="space-y-3" aria-label="Destination settings">
                        <div><h3 className="text-sm font-semibold">Destination settings</h3><p className="mt-0.5 text-xs text-muted-foreground">Each selected network has its own connected account and supported format.</p></div>
                        {selectedPlatforms.map((platform) => { const { Icon, label, accent } = platformMeta[platform]; const formats = socialFormatsFor(platform, media.imageUrls.length, media.videoUrls.length); const accountName = connectedAccounts.find((account) => account.credentialId === targets[platform].credentialId)?.accountName; return <section key={platform} aria-label={`${label} destination settings`} className={cn("rounded-2xl border bg-card p-4 transition-colors", activePlatform === platform && "border-primary/35 ring-1 ring-primary/10")}>
                          <div className="flex items-center justify-between gap-3"><button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => setActivePlatform(platform)}><span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white", accent)}><Icon className="h-4 w-4" /></span><span className="min-w-0"><span className="block text-sm font-semibold">{label}</span><span className="block truncate text-xs text-muted-foreground">{accountName || "Choose an account"}</span></span></button><Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setActivePlatform(platform)}>Preview</Button></div>
                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5"><Label htmlFor={`${platform}-account`}>Connected account</Label>{connectedAccounts.filter(account => account.platform === platform).length === 1 ? <p id={`${platform}-account`} className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">{accountName}</p> : <Select value={targets[platform].credentialId ? String(targets[platform].credentialId) : ""} onValueChange={(value) => updateTarget(platform, { credentialId: Number(value) })}><SelectTrigger id={`${platform}-account`} aria-label={`${label} connected account`}><SelectValue placeholder={`Choose ${label}`} /></SelectTrigger><SelectContent>{connectedAccounts.filter((account) => account.platform === platform).map((account: OrganicPublishingAccount) => <SelectItem key={account.credentialId} value={String(account.credentialId)}>{account.accountName}{account.isSelected ? " · Default" : ""}</SelectItem>)}</SelectContent></Select>}</div>
                            <div className="space-y-1.5"><Label htmlFor={`${platform}-format`}>Publishing format</Label><Select value={targets[platform].postType} onValueChange={(value) => changePostType(platform, value)}><SelectTrigger id={`${platform}-format`} aria-label={`${label} publishing format`}><SelectValue /></SelectTrigger><SelectContent>{formats.map((format) => <SelectItem key={format.value} value={format.value}>{format.label}</SelectItem>)}</SelectContent></Select></div>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-muted-foreground">{formats.length ? <>{socialFormatDescription(platform, targets[platform].postType)}{platform === "facebook" && " Facebook Reels and Stories are not supported here."}</> : noSocialFormatMessage(platform, media.imageUrls.length, media.videoUrls.length)}</p>
                          {platform === "youtube" && <div className="mt-4 space-y-4"><div className="space-y-2"><Label htmlFor="youtube-video-title">YouTube video title</Label><Input id="youtube-video-title" maxLength={100} value={targets.youtube.title} onChange={event => updateTarget('youtube', { title: event.target.value })} /></div><YouTubeReviewFields value={youtube} onChange={patch => setYoutube(current => ({ ...current, ...patch }))} idPrefix="library-youtube" /></div>}
                          {platform === "facebook" && targets.facebook.postType === "video" && <div className="mt-4 space-y-2"><Label htmlFor="facebook-video-title">Optional video title</Label><Input id="facebook-video-title" value={targets.facebook.title} onChange={(event) => updateTarget("facebook", { title: event.target.value })} placeholder="Facebook video title" /></div>}
                          {platform === "instagram" && <InstagramReviewFields value={targets.instagram} postType={targets.instagram.postType} onChange={patch => updateTarget("instagram", patch)} /> }
                        </section>; })}
                      </div>

                      <div className="rounded-2xl border bg-card p-4"><div className="flex items-center justify-between"><div><p className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-primary" />Schedule for later</p><p className="mt-1 text-xs text-muted-foreground">Account timezone: <span className="font-medium text-foreground">{timezone}</span></p></div><Switch aria-label="Schedule for later" checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} /></div>{scheduleEnabled && <div className="mt-3 space-y-2"><Input aria-label="Scheduled date and time" type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />{scheduledAccountTime && <div className="rounded-lg bg-muted/55 px-3 py-2 text-[11px] leading-5 text-muted-foreground"><p>Will publish: <span className="font-medium text-foreground">{scheduledAccountTime}</span></p>{scheduledDeviceTime && <p>On this device: <span className="font-medium text-foreground">{scheduledDeviceTime}</span></p>}</div>}<Link href="/dashboard/settings/preferences" className="inline-flex text-[11px] font-medium text-primary hover:underline">Change account timezone</Link></div>}</div>
                      {selectedPlatforms.includes("youtube") && <p className="text-xs text-muted-foreground">{scheduleEnabled ? YOUTUBE_SCHEDULE_HELP : `YouTube visibility: ${youtube.privacyStatus}. Uploads remain in processing until YouTube confirms completion.`}</p>}
                      {validationError && <Callout tone="warning" size="sm">{validationError}</Callout>}
                      {publishError && <p role="alert" className="text-sm text-destructive">{publishError}</p>}
                    </fieldset>
                    <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t bg-background/95 px-5 py-4 backdrop-blur"><p className="hidden text-xs text-muted-foreground sm:block">A separate reviewed snapshot is saved for every selected destination.</p><Button onClick={() => void publish()} loading={publishing} loadingText={scheduleEnabled ? "Schedule post" : "Publish post"} disabled={Boolean(validationError)} className="ml-auto min-w-36"><Send className="mr-2 h-4 w-4" />{scheduleEnabled ? "Schedule post" : "Publish post"}</Button></div>
                  </div>
                  <div className="bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/.09),transparent_38%),hsl(var(--muted)/.18)] p-5 lg:p-7"><div className="lg:sticky lg:top-5"><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-primary">Proof before publish</p><h3 className="mt-1 font-semibold">{platformMeta[activePlatform].label} preview</h3></div><Badge className={cn("rounded-full border-0", platformMeta[activePlatform].soft)}>Ready for review</Badge></div><Preview platform={activePlatform} caption={activePlatform === "youtube" ? youtubeDescriptionPreview(activeCaption, youtube.chapters) : activeCaption} asset={asset} postType={targets[activePlatform].postType} accountName={activeAccountName} title={targets[activePlatform].title} visibility={youtube.privacyStatus} /></div></div>
                </div>
              </div>;

  return <Dialog open={open} onOpenChange={(next) => { if (!publishingRef.current) onOpenChange(next); }}><DialogContent className="flex max-h-[94dvh] w-[min(1180px,96vw)] max-w-none flex-col overflow-hidden p-0"><DialogHeader className="shrink-0 border-b px-5 py-4 pr-14"><DialogTitle>Publish social post</DialogTitle><DialogDescription>Select destinations, review the account and format for each one, then publish or schedule.</DialogDescription></DialogHeader>{body}</DialogContent></Dialog>;
}
