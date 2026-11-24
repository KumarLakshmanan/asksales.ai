"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, Calendar, Check, Facebook, Linkedin, Instagram, Send, ShieldCheck, Youtube } from "lucide-react";
import type { WidgetProps } from "./types";
import api from "@/lib/api";
import { buildContentMedia } from "@/lib/contentMedia";
import { normalizeUploadUrl, cn } from "@/lib/utils";
import {
  instagramOptionsFor,
  instagramReviewError,
  instagramReviewFromAsset,
  captionFromSocialAsset,
  instagramHashtagCount,
  socialCaptionMeter,
  titleFromSocialAsset,
  publishingIdempotencyKey,
  formatScheduledInstant,
  scheduleToISOString,
  scheduledLocalValue,
  recommendedSocialFormat,
  socialFormatDescription,
  socialFormatsFor,
  noSocialFormatMessage,
  type OrganicPublishPlatform,
  type SocialPublishingAsset,
} from "@/lib/socialPublishing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { findUnresolvedTemplateTokens } from "@/utils/templateVariables";
import { YouTubeReviewFields } from "@/components/social-publishing/YouTubeReviewFields";
import { youtubeReviewFromAsset, youtubeReviewError, youtubeTags, youtubeOptions, youtubeDescriptionPreview, YOUTUBE_SCHEDULE_HELP, type YouTubeReviewSettings } from "@/lib/youtubePublishing";
import { InstagramReviewFields, type InstagramReviewSettings } from "@/components/social-publishing/InstagramReviewFields";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/timezoneDefaults";
import { deviceTimeZone } from "../../../../shared/timeZones";

type WidgetPlatform = OrganicPublishPlatform;

type PublishingAccount = {
  credentialId: number;
  platform: WidgetPlatform;
  providerAccountId: string;
  accountName: string;
  expired: boolean;
  readiness?: 'ready' | 'needs_reconnect';
  isSelected?: boolean;
};

type TargetDraft = InstagramReviewSettings & {
  platform: WidgetPlatform;
  credentialId: number;
  caption: string;
  postType: string;
  title: string;
  privacyStatus: YouTubeReviewSettings['privacyStatus'];
  tags: string;
  youtubeOptions: Omit<YouTubeReviewSettings, 'privacyStatus' | 'tags'>;
  coverUrl: string;
  thumbOffset: string;
};

const PLATFORM_META = {
  linkedin: { label: "LinkedIn", Icon: Linkedin, accent: "bg-[#0A66C2]" },
  instagram: { label: "Instagram", Icon: Instagram, accent: "bg-gradient-to-br from-fuchsia-600 via-pink-500 to-orange-400" },
  facebook: { label: "Facebook", Icon: Facebook, accent: "bg-[#1877F2]" },
  youtube: { label: "YouTube", Icon: Youtube, accent: "bg-red-600" },
} satisfies Record<WidgetPlatform, { label: string; Icon: typeof Instagram; accent: string }>;

function blankTarget(platform: WidgetPlatform, caption = ""): TargetDraft {
  return {
    platform,
    credentialId: 0,
    caption,
    postType: platform === "instagram" ? "post" : (platform === "facebook" || platform === "linkedin") ? "text" : "video",
    title: "",
    privacyStatus: "private",
    tags: "",
    youtubeOptions: {},
    coverUrl: "",
    thumbOffset: "",
  };
}

function initialTargets(values: Record<string, unknown>) {
  const sharedCaption = String(values.caption || "");
  const targets: Record<WidgetPlatform, TargetDraft> = {
    linkedin: blankTarget("linkedin", sharedCaption),
    instagram: blankTarget("instagram", sharedCaption),
    facebook: blankTarget("facebook", sharedCaption),
    youtube: blankTarget("youtube", sharedCaption),
  };
  const reviewedTargets = Array.isArray(values.targets) ? values.targets : [];
  for (const raw of reviewedTargets) {
    if (!raw || typeof raw !== "object") continue;
    const target = raw as Record<string, unknown>;
    const platform = String(target.platform || "") as WidgetPlatform;
    if (!(platform in targets)) continue;
    const instagramOptions = target.instagramOptions && typeof target.instagramOptions === "object" ? target.instagramOptions as Record<string, unknown> : {};
    targets[platform] = {
      ...targets[platform],
      credentialId: Number(target.credentialId) || 0,
      caption: String(target.caption ?? sharedCaption),
      postType: String(target.postType || targets[platform].postType),
      title: String(target.title || ""),
      privacyStatus: target.privacyStatus === "public" || target.privacyStatus === "unlisted" ? target.privacyStatus : "private",
      tags: Array.isArray(target.tags) ? target.tags.join(", ") : "",
      youtubeOptions: target.youtubeOptions && typeof target.youtubeOptions === "object" ? target.youtubeOptions as TargetDraft["youtubeOptions"] : {},
      coverUrl: String(instagramOptions.coverUrl || ""),
      thumbOffset: instagramOptions.thumbOffset === undefined ? "" : String(instagramOptions.thumbOffset),
      altText: typeof instagramOptions.altText === "string" ? instagramOptions.altText : undefined, locationId: typeof instagramOptions.locationId === "string" ? instagramOptions.locationId : undefined, collaborators: Array.isArray(instagramOptions.collaborators) ? instagramOptions.collaborators as string[] : undefined, shareToFeed: typeof instagramOptions.shareToFeed === "boolean" ? instagramOptions.shareToFeed : undefined,
    };
  }
  const legacyPlatform = String(values.platform || "instagram") as WidgetPlatform;
  if (reviewedTargets.length === 0 && legacyPlatform in targets) {
    targets[legacyPlatform] = {
      ...targets[legacyPlatform],
      credentialId: Number(values.credential_id) || 0,
      postType: String(values.post_type || targets[legacyPlatform].postType),
      title: String(values.title || ""),
      privacyStatus: values.privacy_status === "public" || values.privacy_status === "unlisted" ? values.privacy_status : "private",
      tags: Array.isArray(values.tags) ? values.tags.join(", ") : "",
      youtubeOptions: values.youtube_options && typeof values.youtube_options === "object" ? values.youtube_options as TargetDraft["youtubeOptions"] : {},
    };
  }
  return targets;
}

export function PublishPostWidget(props: WidgetProps) {
  return <PublishPostReview key={`${props.widget.id}:${props.widget.formValues.content_asset_id}`} {...props} />;
}

function PublishPostReview({ widget, onFormChange }: WidgetProps) {
  const [timezone, setTimezone] = useState(String(widget.formValues.timezone || DEFAULT_BUSINESS_TIMEZONE));
  const legacyPlatform = String(widget.formValues.platform || "instagram").toLowerCase();
  const isLegacyExternal = legacyPlatform === "twitter";
  const reviewedPlatforms = Array.isArray(widget.formValues.targets)
    ? widget.formValues.targets.map((target) => String((target as Record<string, unknown>).platform || "")).filter((platform) => platform in PLATFORM_META) as WidgetPlatform[]
    : [];
  const initialPlatform = (reviewedPlatforms[0] || (legacyPlatform in PLATFORM_META ? legacyPlatform : "instagram")) as WidgetPlatform;
  const [asset, setAsset] = useState<SocialPublishingAsset | null>(null);
  const [accounts, setAccounts] = useState<PublishingAccount[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState(() => initialTargets(widget.formValues));
  const [selectedPlatforms, setSelectedPlatforms] = useState<WidgetPlatform[]>(reviewedPlatforms.length ? reviewedPlatforms : [initialPlatform]);
  const [activePlatform, setActivePlatform] = useState<WidgetPlatform>(initialPlatform);
  const [sharedCaption, setSharedCaption] = useState(String(widget.formValues.caption || ""));
  const [customize, setCustomize] = useState(reviewedPlatforms.some((platform) => targets[platform]?.caption !== sharedCaption));
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(widget.formValues.scheduled_for));
  const [scheduledFor, setScheduledFor] = useState(scheduledLocalValue(widget.formValues.scheduled_for, timezone));
  const initialIdempotencyKey = useRef(String(widget.formValues.idempotency_key || ""));

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<SocialPublishingAsset>(`/api/content/assets/${Number(widget.formValues.content_asset_id)}`),
      api.get<{ accounts: PublishingAccount[] }>("/api/content/publishing/accounts"),
      api.get<{ timezone?: string; preferences?: { timezone?: string } }>("/api/settings/preferences").catch(() => ({ timezone: DEFAULT_BUSINESS_TIMEZONE, preferences: undefined })),
    ]).then(([loadedAsset, accountResponse, preferences]) => {
      if (cancelled) return;
      setAsset(loadedAsset);
      const preferredTimezone = preferences.timezone || preferences.preferences?.timezone || DEFAULT_BUSINESS_TIMEZONE;
      setTimezone(preferredTimezone);
      if (widget.formValues.scheduled_for) setScheduledFor(scheduledLocalValue(widget.formValues.scheduled_for, preferredTimezone));
      setTargets((current) => {
        const saved = youtubeReviewFromAsset(loadedAsset);
        const reviewed = reviewedPlatforms.includes("youtube");
        return { ...current, instagram: reviewedPlatforms.includes("instagram") ? current.instagram : { ...current.instagram, ...instagramReviewFromAsset(loadedAsset), coverUrl: current.instagram.coverUrl || instagramReviewFromAsset(loadedAsset).coverUrl || "", thumbOffset: current.instagram.thumbOffset || instagramReviewFromAsset(loadedAsset).thumbOffset || "" }, youtube: { ...current.youtube,
          title: reviewed ? current.youtube.title : current.youtube.title || titleFromSocialAsset(loadedAsset),
          ...(!reviewed ? {
            privacyStatus: widget.formValues.privacy_status ? current.youtube.privacyStatus : saved.privacyStatus,
            tags: widget.formValues.tags ? current.youtube.tags : saved.tags,
            youtubeOptions: { ...youtubeOptions(saved), ...current.youtube.youtubeOptions },
          } : {}),
        } };
      });
      setAccounts(accountResponse.accounts.filter((account) => account.platform === "youtube"
        ? account.readiness === "ready" || (!account.expired && account.readiness !== "needs_reconnect")
        : !account.expired));
      setAccountError(null);
      if (widget.formValues.caption === undefined && reviewedPlatforms.length === 0) {
        const caption = captionFromSocialAsset(loadedAsset);
        setSharedCaption(caption);
        setTargets((current) => Object.fromEntries(Object.entries(current).map(([platform, target]) => [platform, { ...target, caption }])) as Record<WidgetPlatform, TargetDraft>);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setAccountError(error instanceof Error ? error.message : "Publishing accounts could not be loaded.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // Initial widget values are immutable for the lifetime of this review card.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id]);

  const media = useMemo(() => buildContentMedia(asset || {}), [asset]);
  const availablePlatforms = useMemo(() => (["instagram", "facebook", "youtube", "linkedin"] as const)
    .filter((platform) => accounts.some((account) => account.platform === platform)), [accounts]);

  useEffect(() => {
    if (!asset || isLegacyExternal) return;
    setTargets((current) => {
      const next = { ...current };
      for (const platform of availablePlatforms) {
        const platformAccounts = accounts.filter((account) => account.platform === platform);
        const preferred = platformAccounts.find((account) => account.isSelected) || (platformAccounts.length === 1 ? platformAccounts[0] : undefined);
        const credentialId = platformAccounts.some((account) => account.credentialId === current[platform].credentialId)
          ? current[platform].credentialId
          : preferred?.credentialId || 0;
        // Formats follow the saved media everywhere (one video -> Reel/video first).
        const formats = socialFormatsFor(platform, media.imageUrls.length, media.videoUrls.length);
        const postType = formats.some((format) => format.value === current[platform].postType)
          ? current[platform].postType
          : formats[0]?.value || recommendedSocialFormat(platform, media.imageUrls.length, media.videoUrls.length);
        next[platform] = { ...current[platform], credentialId, postType };
      }
      return next;
    });
    setSelectedPlatforms((current) => {
      const connected = current.filter((platform) => availablePlatforms.includes(platform));
      return connected.length ? connected : availablePlatforms[0] ? [availablePlatforms[0]] : [];
    });
  }, [accounts, asset, availablePlatforms, isLegacyExternal, media.imageUrls.length, media.videoUrls.length]);

  useEffect(() => {
    if (!selectedPlatforms.includes(activePlatform) && selectedPlatforms[0]) setActivePlatform(selectedPlatforms[0]);
  }, [activePlatform, selectedPlatforms]);

  const validationError = useMemo(() => {
    if (loading) return "Loading saved content and publishing accounts before approval.";
    if (accountError) return accountError;
    if (scheduleEnabled) {
      try {
        if (Date.parse(scheduleToISOString(scheduledFor, timezone)) <= Date.now() + 60_000) return "Choose a schedule at least one minute in the future.";
      } catch (error) { return error instanceof Error ? error.message : "Choose a valid schedule."; }
    }
    if (findUnresolvedTemplateTokens(sharedCaption).length) return "Resolve every template variable before publishing.";
    if (isLegacyExternal) return null;
    if (!asset?.version || !asset.publishingReviewToken) return "Reload the saved content to review its latest version before approval.";
    if (!selectedPlatforms.length) return "Connect and select at least one publishing destination.";
    for (const platform of selectedPlatforms) {
      const target = targets[platform];
      if (platform === "instagram") { const error = instagramReviewError(target.postType, target); if (error) return error; }
      const caption = customize ? target.caption : sharedCaption;
      if (findUnresolvedTemplateTokens(caption, target.title, platform === "youtube" ? target.tags : "").length) return "Resolve every template variable before publishing.";
      if (platform === "instagram" && instagramHashtagCount(caption) > 30) return "Instagram captions support at most 30 hashtags.";
      if (platform === "instagram" && caption.length > 2200) return "Instagram captions support at most 2,200 characters.";
      if (platform === "linkedin" && (!caption.trim() || caption.length > 3000)) return "LinkedIn text must contain 1–3,000 characters.";
      if (platform === "facebook" && caption.length > 63206) return "Facebook posts support at most 63,206 characters.";
      if (!target.credentialId) return `Choose a ${PLATFORM_META[platform].label} account.`;
      if (platform === "instagram" && target.postType === "story" && caption.trim()) return "Instagram Stories cannot include a caption in this integration.";
      if (platform === "instagram" && target.postType === "reel" && target.coverUrl && !/^https:\/\//i.test(target.coverUrl)) return "Instagram Reel covers must use HTTPS.";
      if (platform === "instagram" && target.postType === "reel" && target.thumbOffset && (!Number.isFinite(Number(target.thumbOffset)) || Number(target.thumbOffset) < 0)) return "Instagram thumbnail offset must be zero or greater.";
      if (platform === "youtube" && (media.videoUrls.length !== 1 || media.imageUrls.length !== 0)) return "YouTube requires exactly one video and no images.";
      if (platform === "youtube" && (!target.title.trim() || target.title.length > 100)) return "YouTube requires a title of 1–100 characters.";
      if (platform === "youtube" && /[<>]/.test(target.title + caption)) return "YouTube titles and descriptions cannot contain < or >.";
      if (platform === "youtube" && new TextEncoder().encode(youtubeDescriptionPreview(caption, target.youtubeOptions.chapters)).length > 5000) return "YouTube descriptions support at most 5,000 UTF-8 bytes.";
      if (platform === "youtube") {
        const error = youtubeReviewError({ privacyStatus: target.privacyStatus, tags: target.tags, ...target.youtubeOptions });
        if (error) return error;
      }
      const supported = socialFormatsFor(platform, media.imageUrls.length, media.videoUrls.length).some((format) => format.value === target.postType);
      if (!supported) return `${PLATFORM_META[platform].label} cannot publish this asset in the selected format.`;
    }
    return null;
  }, [asset, loading, accountError, timezone, customize, isLegacyExternal, media.imageUrls.length, media.videoUrls.length, scheduleEnabled, scheduledFor, selectedPlatforms, sharedCaption, targets]);

  useEffect(() => {
    let scheduled_for = "";
    if (scheduleEnabled && scheduledFor) {
      try { scheduled_for = scheduleToISOString(scheduledFor, timezone); } catch { /* Validation blocks approval. */ }
    }
    if (isLegacyExternal) {
      const payload = {
        content_asset_id: Number(widget.formValues.content_asset_id),
        platform: legacyPlatform,
        caption: sharedCaption,
        scheduled_for,
        timezone,
      };
      onFormChange({ ...payload, idempotency_key: publishingIdempotencyKey(`widget:${widget.id}`, payload, initialIdempotencyKey.current || undefined), _review_validation_error: validationError || undefined });
      initialIdempotencyKey.current = "";
      return;
    }
    const payload = {
      content_asset_id: Number(widget.formValues.content_asset_id),
      expected_version: asset?.version,
      expected_review_token: asset?.publishingReviewToken,
      targets: selectedPlatforms.map((platform) => {
        const target = targets[platform];
        return {
          platform,
          credentialId: target.credentialId || undefined,
          caption: customize ? target.caption : sharedCaption,
          postType: target.postType,
          title: target.title || undefined,
          privacyStatus: platform === "youtube" ? target.privacyStatus : undefined,
          tags: platform === "youtube" ? youtubeTags(target.tags) : undefined,
          youtubeOptions: platform === "youtube" ? target.youtubeOptions : undefined,
          instagramOptions: platform === "instagram" ? instagramOptionsFor(target.postType, target) : undefined,
        };
      }),
      scheduled_for,
      timezone,
    };
    onFormChange({ ...payload, idempotency_key: publishingIdempotencyKey(`widget:${widget.id}`, payload, initialIdempotencyKey.current || undefined), _review_validation_error: validationError || undefined });
    initialIdempotencyKey.current = "";
  // onFormChange is owned by the widget autosave layer and intentionally excluded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.version, asset?.publishingReviewToken, customize, isLegacyExternal, legacyPlatform, scheduleEnabled, scheduledFor, selectedPlatforms, sharedCaption, targets, timezone, validationError, widget.id, widget.formValues.content_asset_id]);

  const updateTarget = (platform: WidgetPlatform, update: Partial<TargetDraft>) => setTargets((current) => ({ ...current, [platform]: { ...current[platform], ...update } }));
  const activeCaption = customize ? targets[activePlatform]?.caption || "" : sharedCaption;
  const activeAccountName = accounts.find((account) => account.credentialId === targets[activePlatform].credentialId)?.accountName || "Connected account";
  const captionLabel = customize
    ? activePlatform === "youtube" ? "YouTube description" : `${PLATFORM_META[activePlatform].label} caption`
    : selectedPlatforms.length > 1 && selectedPlatforms.includes("youtube")
      ? "Shared caption and video description"
      : selectedPlatforms.length > 1 ? "Shared caption" : activePlatform === "youtube" ? "YouTube description" : "Caption";
  const changePostType = (platform: WidgetPlatform, postType: string) => {
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
  const previewItem = media.items[0];

  if (isLegacyExternal) {
    return <div className="space-y-4"><div className="rounded-xl border bg-card p-3"><p className="text-sm font-semibold capitalize">Publishing to {legacyPlatform}</p><p className="text-xs text-muted-foreground">Asset #{Number(widget.formValues.content_asset_id)}</p></div><div className="space-y-2"><Label>Caption</Label><Textarea rows={5} value={sharedCaption} onChange={(event) => setSharedCaption(event.target.value)} /></div><Schedule enabled={scheduleEnabled} setEnabled={setScheduleEnabled} value={scheduledFor} setValue={setScheduledFor} timezone={timezone} />{validationError && <p role="alert" className="text-sm text-destructive">{validationError}</p>}</div>;
  }

  if (loading) {
    return <LoadingState className="min-h-40 py-0" label="Loading publishing accounts…" />;
  }

  if (!accountError && availablePlatforms.length === 0) {
    return <div className="rounded-2xl border border-dashed p-6 text-center"><Send className="mx-auto h-7 w-7 text-primary" /><p className="mt-3 text-sm font-semibold">Connect a publishing account</p><p className="mt-1 text-xs text-muted-foreground">Facebook, Instagram, or YouTube must be connected before approval.</p><Button asChild size="sm" className="mt-4"><Link href="/dashboard/integrations">Connect social accounts</Link></Button></div>;
  }

  if (accountError && availablePlatforms.length === 0) {
    return <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-5 text-center"><AlertCircle className="mx-auto h-6 w-6 text-destructive" /><p className="mt-2 text-sm font-semibold">Publishing accounts unavailable</p><p className="mt-1 text-xs text-muted-foreground">{accountError}</p></div>;
  }

  return <div className="space-y-4">
    <div className="rounded-2xl border bg-card p-3">
      <div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-primary">Approval proof</p><p className="mt-1 text-sm font-semibold">Asset #{Number(widget.formValues.content_asset_id)}</p></div><Badge variant="outline" className="gap-1"><ShieldCheck className="h-3 w-3" /> Draft</Badge></div>
      <div className="mt-3 flex flex-wrap gap-2">{availablePlatforms.map((platform) => { const { Icon, label, accent } = PLATFORM_META[platform]; const selected = selectedPlatforms.includes(platform); const preferred = accounts.find((account) => account.platform === platform && account.isSelected) || accounts.find((account) => account.platform === platform); return <button type="button" key={platform} aria-pressed={selected} aria-label={`${label} ${preferred?.accountName || "connected account"}`} onClick={() => { setSelectedPlatforms((current) => current.includes(platform) ? current.length === 1 ? current : current.filter((value) => value !== platform) : [...current, platform]); setActivePlatform(platform); }} className={cn("flex items-center gap-2 rounded-xl border px-2.5 py-2 text-xs font-semibold", selected ? "border-primary/40 bg-primary/5" : "border-border bg-background")}><span className={cn("grid h-7 w-7 place-items-center rounded-lg text-white", accent)}><Icon className="h-3.5 w-3.5" /></span>{label}{selected && <Check className="h-3 w-3 text-primary" />}</button>; })}</div>
    </div>

    <div className="grid gap-4 @md/review:grid-cols-[minmax(0,1fr)_180px]">
      <div className="space-y-4">
        <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><Label>{captionLabel}</Label><label className="flex items-center gap-2 text-[11px] text-muted-foreground"><Switch aria-label="Different caption for each network" checked={customize} onCheckedChange={(checked) => { if (checked) setTargets((current) => Object.fromEntries(Object.entries(current).map(([platform, target]) => [platform, { ...target, caption: sharedCaption }])) as Record<WidgetPlatform, TargetDraft>); setCustomize(checked); }} />Different caption for each network</label></div>{customize && <div className="flex flex-wrap gap-1.5" aria-label="Caption destination">{selectedPlatforms.map((platform) => <Button key={platform} type="button" size="sm" variant={activePlatform === platform ? "secondary" : "ghost"} className="h-7 rounded-full px-3 text-xs" onClick={() => setActivePlatform(platform)}>{PLATFORM_META[platform].label}</Button>)}</div>}<Textarea aria-label={captionLabel} rows={5} value={activeCaption} onChange={(event) => customize ? updateTarget(activePlatform, { caption: event.target.value }) : setSharedCaption(event.target.value)} /><p className="flex justify-between text-[10px] text-muted-foreground"><span>{customize ? `Editing ${PLATFORM_META[activePlatform].label}` : selectedPlatforms.length > 1 ? `Used for ${selectedPlatforms.map((platform) => PLATFORM_META[platform].label).join(" and ")}` : `Used for ${PLATFORM_META[activePlatform].label}`}</span><span>{socialCaptionMeter(activePlatform, activePlatform === "youtube" ? youtubeDescriptionPreview(activeCaption, targets.youtube.youtubeOptions.chapters) : activeCaption)}</span></p></div>
        <div className="space-y-3"><div><p className="text-xs font-semibold">Destination settings</p><p className="text-[10px] text-muted-foreground">Review the account and supported format for every selected network.</p></div>{selectedPlatforms.map((platform) => { const { Icon, label, accent } = PLATFORM_META[platform]; const formats = socialFormatsFor(platform, media.imageUrls.length, media.videoUrls.length); const accountName = accounts.find((account) => account.credentialId === targets[platform].credentialId)?.accountName; return <section key={platform} aria-label={`${label} destination settings`} className={cn("rounded-xl border bg-card p-3", activePlatform === platform && "border-primary/35 ring-1 ring-primary/10")}><div className="flex items-center justify-between gap-2"><button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => setActivePlatform(platform)}><span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white", accent)}><Icon className="h-3.5 w-3.5" /></span><span className="min-w-0"><span className="block text-xs font-semibold">{label}</span><span className="block truncate text-[10px] text-muted-foreground">{accountName || "Choose an account"}</span></span></button><Button type="button" size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => setActivePlatform(platform)}>Preview</Button></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor={`widget-${widget.id}-${platform}-account`}>Connected account</Label>{accounts.filter(account => account.platform === platform).length === 1 ? <p id={`widget-${widget.id}-${platform}-account`} className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">{accountName}</p> : <Select value={targets[platform].credentialId ? String(targets[platform].credentialId) : ""} onValueChange={(value) => updateTarget(platform, { credentialId: Number(value) })}><SelectTrigger id={`widget-${widget.id}-${platform}-account`} aria-label={`${label} connected account`}><SelectValue placeholder={`Choose ${label}`} /></SelectTrigger><SelectContent>{accounts.filter((account) => account.platform === platform).map((account) => <SelectItem key={account.credentialId} value={String(account.credentialId)}>{account.accountName}{account.isSelected ? " · Default" : ""}</SelectItem>)}</SelectContent></Select>}</div><div className="space-y-1.5"><Label htmlFor={`widget-${widget.id}-${platform}-format`}>Publishing format</Label><Select value={targets[platform].postType} onValueChange={(value) => changePostType(platform, value)}><SelectTrigger id={`widget-${widget.id}-${platform}-format`} aria-label={`${label} publishing format`}><SelectValue /></SelectTrigger><SelectContent>{formats.map((format) => <SelectItem key={format.value} value={format.value}>{format.label}</SelectItem>)}</SelectContent></Select></div></div><p className="mt-2 text-[10px] leading-4 text-muted-foreground">{formats.length ? socialFormatDescription(platform, targets[platform].postType) : noSocialFormatMessage(platform, media.imageUrls.length, media.videoUrls.length)}</p>{platform === "facebook" && targets.facebook.postType === "video" && <div className="mt-3 space-y-1.5"><Label>Optional video title</Label><Input value={targets.facebook.title} onChange={(event) => updateTarget("facebook", { title: event.target.value })} /></div>}{platform === "youtube" && <div className="mt-3 space-y-3"><div className="space-y-1.5"><Label htmlFor="review-youtube-title">Video title</Label><Input id="review-youtube-title" maxLength={100} value={targets.youtube.title} onChange={(event) => updateTarget("youtube", { title: event.target.value })} /></div><YouTubeReviewFields idPrefix={`widget-${widget.id}`} value={{ privacyStatus: targets.youtube.privacyStatus, tags: targets.youtube.tags, ...targets.youtube.youtubeOptions }} onChange={(patch) => { const value = { privacyStatus: targets.youtube.privacyStatus, tags: targets.youtube.tags, ...targets.youtube.youtubeOptions, ...patch }; updateTarget("youtube", { privacyStatus: value.privacyStatus, tags: value.tags, youtubeOptions: youtubeOptions(value) }); }} /><p className="text-xs text-muted-foreground">{YOUTUBE_SCHEDULE_HELP}</p></div>}{platform === "instagram" && <InstagramReviewFields value={targets.instagram} postType={targets.instagram.postType} onChange={patch => updateTarget("instagram", patch)} idPrefix={`widget-${widget.id}-instagram`} /> }</section>; })}</div>
        {validationError && <Callout tone="warning" size="sm" icon={AlertCircle}>{validationError}</Callout>}
        <Schedule enabled={scheduleEnabled} setEnabled={setScheduleEnabled} value={scheduledFor} setValue={setScheduledFor} timezone={timezone} />
      </div>
      <div className="overflow-hidden rounded-2xl border bg-background"><div className="flex items-center gap-2 border-b p-2.5"><span className={cn("grid h-7 w-7 place-items-center rounded-lg text-white", PLATFORM_META[activePlatform].accent)}>{(() => { const Icon = PLATFORM_META[activePlatform].Icon; return <Icon className="h-3.5 w-3.5" />; })()}</span><div className="min-w-0"><p className="truncate text-[11px] font-semibold">{activeAccountName}</p><p className="text-[9px] text-muted-foreground">Draft proof</p></div></div>{previewItem?.type === "video" ? <video src={normalizeUploadUrl(previewItem.url)} className="aspect-square w-full bg-black object-cover" muted controls /> : previewItem ? <img src={normalizeUploadUrl(previewItem.url)} alt="Saved post preview" className="aspect-square w-full object-cover" /> : null}<p className="line-clamp-6 whitespace-pre-wrap p-3 text-[11px] leading-5">{(activePlatform === "youtube" ? youtubeDescriptionPreview(activeCaption, targets.youtube.youtubeOptions.chapters) : activeCaption) || "Your reviewed caption will appear here."}</p></div>
    </div>
  </div>;
}

function Schedule({ enabled, setEnabled, value, setValue, timezone }: { enabled: boolean; setEnabled: (value: boolean) => void; value: string; setValue: (value: string) => void; timezone: string }) {
  const deviceTimezone = deviceTimeZone(DEFAULT_BUSINESS_TIMEZONE);
  let accountTime = "";
  let deviceTime = "";
  if (enabled && value) {
    try {
      accountTime = formatScheduledInstant(value, timezone);
      if (deviceTimezone !== timezone) {
        const candidate = formatScheduledInstant(value, timezone, deviceTimezone);
        if (candidate !== accountTime) deviceTime = candidate;
      }
    } catch { /* Validation displays the invalid wall-time error. */ }
  }
  return <div className="rounded-xl border bg-muted/25 p-3"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Calendar className="h-4 w-4 text-primary" /><div><p className="text-xs font-semibold">Schedule for later</p><p className="text-[10px] text-muted-foreground">Account timezone: <span className="font-medium text-foreground">{timezone}</span></p></div></div><Switch aria-label="Schedule for later" checked={enabled} onCheckedChange={setEnabled} /></div>{enabled && <div className="mt-3 space-y-2"><Input aria-label="Scheduled date and time" type="datetime-local" value={value} onChange={(event) => setValue(event.target.value)} />{accountTime && <div className="rounded-lg bg-background/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground"><p>Will publish: <span className="font-medium text-foreground">{accountTime}</span></p>{deviceTime && <p>On this device: <span className="font-medium text-foreground">{deviceTime}</span></p>}</div>}<Link href="/dashboard/settings/preferences" className="inline-flex text-[10px] font-medium text-primary hover:underline">Change account timezone</Link></div>}</div>;
}
