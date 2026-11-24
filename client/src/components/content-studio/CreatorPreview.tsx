"use client";

import { useEffect, useState } from "react";
import {
  Battery,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Mail,
  MonitorPlay,
  MoreHorizontal,
  Play,
  Signal,
  Sparkles,
  UserRound,
  Wifi,
  PenLine,
  AlertCircle,
} from "lucide-react";
import { cn, normalizeUploadUrl } from "@/lib/utils";
import { Callout } from "@/components/ui/callout";
import { MediaGenerationPlaceholder } from "@/components/content-studio/MediaGenerationPlaceholder";
import { VIDEO_GENERATION_ESTIMATE, videoGenerationProgressLabel } from "@/lib/videoSourceImage";
import type { ManualDraft } from "./GeneratorMode";
import { sanitizeEmailPreviewHtml } from "@/lib/contentTemplateRendering";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { calculateSmsMetrics } from "@/lib/smsMetrics";
import { VariableProof } from "./VariableProof";

export type CreatorFormat = "social" | "blog" | "email" | "sms" | "dm" | "ad" | "image" | "video";
export type PreviewStatus = "empty" | "draft" | "ready" | "generating" | "failed";

/** Companion media that is still generating (or failed) after the text is ready. */
export interface PendingPreviewMedia {
  kind: "image" | "video";
  status: "generating" | "failed";
  error?: string;
  startedAt?: string;
}

interface PreviewBase {
  format: CreatorFormat;
  status?: PreviewStatus;
  title?: string;
  submittedPrompt?: string;
  error?: string;
}

export type CreatorPreviewModel =
  | (PreviewBase & { format: "social"; caption: string; hashtags?: string[]; platform?: string; mediaUrl?: string; mediaType?: "image" | "video"; mediaItems?: Array<{ url: string; type: "image" | "video" }>; pendingMedia?: PendingPreviewMedia[] })
  | (PreviewBase & { format: "blog"; body: string; category?: string; targetWords?: number })
  | (PreviewBase & { format: "email"; subject?: string; preheader?: string; body: string; html?: string; audience?: string; cta?: string })
  | (PreviewBase & { format: "sms"; message: string; maxCharacters?: number; includeOptOut?: boolean })
  | (PreviewBase & { format: "dm"; message: string; recipient?: string; platform?: string })
  | (PreviewBase & { format: "ad"; body: string; headline?: string; cta?: string; brand?: string; productUrl?: string; mediaUrl?: string })
  | (PreviewBase & { format: "image"; prompt: string; sourceUrl?: string; aspectRatio?: string; style?: string; size?: string })
  | (PreviewBase & { format: "video"; prompt: string; startFrameUrl?: string; videoUrl?: string; aspectRatio?: string; duration?: string; resolution?: string; style?: string });

const STATUS_LABEL: Record<PreviewStatus, string> = {
  empty: "No preview yet",
  draft: "Live draft",
  ready: "Generated draft",
  generating: "Generating",
  failed: "Needs attention",
};

export function manualDraftPreview(format: Exclude<CreatorFormat, "social" | "video">, draft: ManualDraft, platform?: string): CreatorPreviewModel {
  const base = { status: "draft" as const, title: draft.title };
  switch (format) {
    case "email": return { ...base, format, subject: draft.subject, body: draft.content };
    case "sms": return { ...base, format, message: draft.content };
    case "dm": return { ...base, format, message: draft.content, platform };
    case "blog": return { ...base, format, body: draft.content };
    case "ad": return { ...base, format, headline: draft.title, body: draft.content, mediaUrl: draft.mediaType === "image" ? draft.mediaUrl : undefined };
    case "image": return { ...base, format, prompt: draft.content, sourceUrl: draft.mediaUrl };
  }
}

function countWords(value: string) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function ProofStrip({ model }: { model: CreatorPreviewModel }) {
  const status = model.status || "draft";
  const facts: string[] = [];
  if (model.format === "social") facts.push(model.platform === "all" ? "All platforms" : model.platform || "All platforms", `${model.caption.length} characters`);
  if (model.format === "blog") facts.push(`${countWords(model.body)} words`, `${Math.max(1, Math.ceil(countWords(model.body) / 200))} min read`);
  if (model.format === "email") facts.push(`${countWords(model.body)} words`);
  if (model.format === "sms") facts.push(`${model.message.length}${model.maxCharacters ? `/${model.maxCharacters}` : ""} characters`);
  if (model.format === "dm") facts.push(model.platform === "all" ? "All social platforms" : model.platform || "Social DM");
  if (model.format === "ad") facts.push(model.cta || "CTA not set", model.productUrl ? "Landing page set" : "No landing page");
  if (model.format === "image") facts.push(model.aspectRatio || "1:1", model.size || "Standard", model.style || "Auto style");
  if (model.format === "video") facts.push(model.aspectRatio || "16:9", model.duration || "5 seconds", model.resolution || "720p");

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-3 text-xs">
      <span className={cn(
        "inline-flex items-center gap-1.5 font-semibold",
        status === "failed" ? "text-destructive" : status === "ready" ? "text-success" : "text-primary",
      )}>
        {status === "generating" ? <Sparkles className="h-3.5 w-3.5 animate-pulse" /> : status === "draft" ? <PenLine className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        {STATUS_LABEL[status]}
      </span>
      {facts.map((fact) => <span key={fact} className="font-mono text-[11px] text-muted-foreground">{fact}</span>)}
    </div>
  );
}

function EmptyMedia({ label, icon: Icon = ImageIcon }: { label: string; icon?: typeof ImageIcon }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 bg-muted/55 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
        <Icon className="h-6 w-6" />
      </div>
      <p className="max-w-xs text-sm leading-6 text-muted-foreground">{label}</p>
    </div>
  );
}

function PreviewFrame({ model, children }: { model: CreatorPreviewModel; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-md)]">
      <ProofStrip model={model} />
      {children}
    </div>
  );
}

const GENERATION_LABEL: Record<CreatorFormat, string> = {
  social: "Drafting your social post",
  blog: "Drafting your blog post",
  email: "Drafting your email",
  sms: "Drafting your SMS",
  dm: "Drafting your direct message",
  ad: "Drafting your ad creative",
  image: "Rendering your image",
  video: "Rendering your video",
};

const COMPOSITION_GUIDE: Record<CreatorFormat, string> = {
  email: 'Include the audience, purpose, one clear next step, and the desired tone. Review the subject and inbox snippet before using the draft in a campaign.',
  sms: 'Include the offer, destination link, and opt-out requirements. Unicode and variable substitutions can increase the number of billed segments.',
  dm: 'Name the recipient profile, platform, and reason for reaching out. Add examples for personalization fields before handing off to outreach.',
  social: 'Choose a platform, describe the audience and message, then decide whether to generate media. All platforms creates separate variants.',
  ad: 'Choose a placement, add an approved landing page, and describe your offer. Review claims and headline alternatives before campaign setup.',
  blog: 'Add your audience, source URLs, and target keywords. Use outline review for longer articles and verify citations before publishing.',
  image: 'Describe the subject, composition, aspect ratio, and intended placement. Compare results and add alternative text before attaching to a draft.',
  video: 'Describe the opening shot, motion, audio, and duration. Approve a storyboard for longer clips. Submitted jobs can be recovered from your library.',
};

function GeneratingPreview({ model }: { model: CreatorPreviewModel }) {
  const kind = model.format === "image" || model.format === "video" ? model.format : "content";
  const prompt = model.submittedPrompt ?? (model.format === "image" || model.format === "video"
    ? model.prompt
    : model.format === "sms" || model.format === "dm"
      ? model.message
      : model.format === "social"
        ? model.caption
        : model.body);

  return (
    <PreviewFrame model={model}>
      <MediaGenerationPlaceholder
        kind={kind}
        label={GENERATION_LABEL[model.format]}
        detail={model.format === "video" ? `Most videos take ${VIDEO_GENERATION_ESTIMATE}. You can leave this page; the saved job keeps running.` : undefined}
        className="min-h-[420px]"
      />
      {prompt && (
        <div className="border-t border-border bg-card px-5 py-4">
          <p className="text-xs font-semibold text-foreground">Submitted prompt</p>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">{prompt}</p>
        </div>
      )}
    </PreviewFrame>
  );
}

function SocialPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "social" }> }) {
  const [mediaIndex, setMediaIndex] = useState(0);
  const [cropProof, setCropProof] = useState('original');
  const [safeArea, setSafeArea] = useState(false);
  const seenUrls = new Set<string>();
  const mediaItems = (model.mediaItems?.length
    ? model.mediaItems
    : model.mediaUrl
      ? [{ url: model.mediaUrl, type: model.mediaType || "image" }]
      : []
  ).filter((item) => {
    const url = item.url.trim();
    if (!url || seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
  const currentMedia = mediaItems[mediaIndex] || mediaItems[0];

  useEffect(() => {
    if (mediaIndex >= mediaItems.length) setMediaIndex(0);
  }, [mediaIndex, mediaItems.length]);

  return (
    <PreviewFrame model={model}>
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary"><UserRound className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold">Your brand</p><p className="text-xs text-muted-foreground">Post preview · not published</p></div>
        <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="space-y-3 px-5 py-4">
        <p className={cn("whitespace-pre-wrap text-sm leading-6", !model.caption && "text-muted-foreground")}>{model.caption || "Your post copy will appear here as you write."}</p>
        {!!model.hashtags?.length && <p className="text-sm text-primary">{[...new Set(model.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`))].filter((tag) => !model.caption.toLowerCase().split(/\s+/).includes(tag.toLowerCase())).join(" ")}</p>}
      </div>
      {model.pendingMedia?.map((pending) => pending.status === "generating"
        ? <MediaGenerationPlaceholder key={pending.kind} kind={pending.kind} compact className="aspect-video min-h-0 border-t border-border" label={pending.kind === "video" ? "Generating video" : "Generating image"} detail={pending.kind === "video" ? videoGenerationProgressLabel(pending.startedAt) : "Usually under a minute."} />
        : <Callout key={pending.kind} tone="danger" className="mx-5 mb-4">{pending.kind === "video" ? "Video" : "Image"} generation failed{pending.error ? `: ${pending.error}` : "."} Your caption is saved; you can generate the {pending.kind} again.</Callout>)}
      {currentMedia ? (
        <div className="bg-muted">
          <div className="flex flex-wrap gap-3 border-y border-border p-2 text-xs"><label>Crop proof <select aria-label="Social crop proof" value={cropProof} onChange={(event) => setCropProof(event.target.value)} className="rounded border border-border bg-background p-1"><option value="original">Original</option><option value="1 / 1">Square</option><option value="4 / 5">Portrait</option><option value="9 / 16">Vertical</option></select></label><label className="flex items-center gap-1"><input type="checkbox" checked={safeArea} onChange={(event) => setSafeArea(event.target.checked)} />Safe-area guide</label><span className="text-muted-foreground">Proof only; does not crop the saved file.</span></div>
        <div className="relative overflow-hidden" style={cropProof !== 'original' ? { aspectRatio: cropProof } : undefined}>
          {currentMedia.type === "video"
            ? <video controls src={normalizeUploadUrl(currentMedia.url)} className={cropProof === 'original' ? "max-h-[480px] w-full bg-black object-contain" : "h-full w-full bg-black object-cover"} />
            : <img src={normalizeUploadUrl(currentMedia.url)} alt={`Post media preview ${mediaIndex + 1}`} className={cropProof === 'original' ? "max-h-[480px] w-full bg-muted object-contain" : "h-full w-full object-cover"} />}
          {safeArea && <div aria-label="Approximate safe area" className="pointer-events-none absolute inset-x-[10%] inset-y-[15%] border-2 border-dashed border-white/90 shadow-[0_0_0_100px_rgba(0,0,0,0.2)]" />}
          {mediaItems.length > 1 && (
            <>
              <button type="button" onClick={() => setMediaIndex((index) => index === 0 ? mediaItems.length - 1 : index - 1)} className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white hover:bg-black/80" aria-label="Previous carousel item"><ChevronLeft className="h-5 w-5" /></button>
              <button type="button" onClick={() => setMediaIndex((index) => index === mediaItems.length - 1 ? 0 : index + 1)} className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white hover:bg-black/80" aria-label="Next carousel item"><ChevronRight className="h-5 w-5" /></button>
              <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2 py-1 text-xs font-semibold text-white">{mediaIndex + 1}/{mediaItems.length}</span>
            </>
          )}
        </div>
        </div>
      ) : <EmptyMedia label="Add media or generate the post to see the finished social creative." />}
      <div className="grid grid-cols-3 border-t border-border px-4 py-3 text-xs font-medium text-muted-foreground"><span>Like</span><span className="text-center">Comment</span><span className="text-right">Share</span></div>
    </PreviewFrame>
  );
}

function BlogPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "blog" }> }) {
  // Providers often repeat the separately supplied title as the first heading.
  // Only omit that exact duplicate in the proof; keep the saved article intact.
  const leadingHeading = model.body.match(/^\s*#{1,2}\s+([^\n]+)\r?\n(?:\s*\n)?/);
  const body = leadingHeading && leadingHeading[1].trim() === model.title?.trim()
    ? model.body.slice(leadingHeading[0].length)
    : model.body;
  return (
    <PreviewFrame model={model}>
      <article className="mx-auto max-w-[68ch] px-6 py-8 sm:px-10 sm:py-12">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{model.category || "Article draft"}</p>
        <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">{model.title || "Your working title"}</h2>
        <div className="mt-4 border-b border-border pb-5 text-xs text-muted-foreground">Article preview · not published</div>
        <div className="prose prose-sm mt-6 max-w-none text-foreground prose-headings:text-foreground prose-strong:text-foreground dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body || "Start writing your article to preview it here."}</ReactMarkdown></div>
      </article>
    </PreviewFrame>
  );
}

function EmailPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "email" }> }) {
  const [mobile, setMobile] = useState(false);
  const preheader = model.preheader || model.body.replace(/\s+/g, ' ').slice(0, 110);
  const warnings = [
    (model.subject || '').length > 60 ? 'Long subject: check truncation on mobile.' : '',
    /(?:act now|guaranteed|100% free|risk.free)/i.test(`${model.subject} ${model.body}`) ? 'Review promotional claims and spam-sensitive wording.' : '',
    /\[(?:insert|add|your).*?(?:link|url)\]/i.test(model.body) ? 'Replace unfinished link placeholders before sending.' : '',
  ].filter(Boolean);
  return (
    <PreviewFrame model={model}>
      <div className="border-b border-border bg-muted/25 px-5 py-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="flex items-center gap-2"><Mail className="h-4 w-4" /> Email preview · not sent</span><button type="button" aria-pressed={mobile} onClick={() => setMobile(!mobile)} className="rounded border border-border px-2 py-1">{mobile ? 'Desktop proof' : 'Mobile proof'}</button></div>
        <p className="mt-3 truncate text-sm font-medium">{model.subject || 'Subject line'}</p>
        <p className="truncate text-xs text-muted-foreground">{preheader || 'Inbox snippet from the opening content'}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">Inbox approximation; each email client may render differently.</p>
        {model.preheader && <p className="mt-1 text-[10px] text-muted-foreground">Suggested preheader. Add it to your campaign email design before sending.</p>}
      </div>
      <div className="border-b border-border px-5 py-4 text-sm"><span className="mr-3 text-muted-foreground">Subject</span><strong>{model.subject || model.title || "Your email subject"}</strong></div>
      <div className={cn("mx-auto px-6 py-7 sm:px-10", mobile && "max-w-[375px]")}>
        {model.audience && <p className="text-sm text-muted-foreground">To: {model.audience}</p>}
        {model.html ? <iframe title="Email design preview" sandbox="" srcDoc={sanitizeEmailPreviewHtml(model.html)} className="min-h-[400px] w-full rounded-md border-0 bg-white" /> : <div className="whitespace-pre-wrap text-[15px] leading-7">{model.body || "Start writing your email to preview it here."}</div>}
        {model.cta && <span className="mt-7 inline-block rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">{model.cta}</span>}
      </div>
      {warnings.length > 0 && <ul className="border-t border-border p-4 text-xs text-amber-700 dark:text-amber-400">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      <VariableProof text={`${model.subject || ''}\n${model.body}`} />
    </PreviewFrame>
  );
}

function PhoneChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[360px] rounded-[2rem] border-[6px] border-foreground/90 bg-card shadow-[var(--shadow-lg)]">
      <div className="flex items-center justify-between px-5 py-2 font-mono text-[10px]"><span>9:41</span><span className="flex items-center gap-1"><Signal className="h-3 w-3" /><Wifi className="h-3 w-3" /><Battery className="h-3 w-3" /></span></div>
      {children}
    </div>
  );
}

function SmsPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "sms" }> }) {
  const limit = model.maxCharacters;
  const metrics = calculateSmsMetrics(model.message);
  return (
    <div className="mx-auto max-w-[760px]">
      <ProofStrip model={model} />
      <div className="bg-muted/20 px-4 py-8">
        <PhoneChrome>
          <div className="border-y border-border px-4 py-3 text-center"><p className="text-sm font-semibold">Your brand</p><p className="text-[10px] text-muted-foreground">Text message</p></div>
          <div className="min-h-[360px] bg-muted/30 p-4">
            <div className="ml-auto max-w-[88%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-5 text-primary-foreground">
              {model.message || "Your SMS will appear here."}
            </div>
            <p className={cn("mt-2 text-right font-mono text-[10px]", limit && model.message.length > limit ? "text-destructive" : "text-muted-foreground")}>{model.message.length}{limit ? `/${limit}` : " characters"}</p>
            <p className="mt-2 text-right text-xs text-muted-foreground">{metrics.encoding} · {metrics.units} units · {metrics.segments} segment{metrics.segments === 1 ? "" : "s"}</p>
            <p className="mt-3 text-xs text-muted-foreground">Variable values and tracked links can change the final segment count and sending cost.</p>
            {!/\bSTOP\b/i.test(model.message) && <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">Marketing message? Include the opt-out wording required by your sending provider.</p>}
          </div>
        </PhoneChrome>
        <VariableProof text={model.message} />
      </div>
    </div>
  );
}

function DmPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "dm" }> }) {
  const limits: Record<string, number> = { instagram: 1000, linkedin: 1900, twitter: 10000, facebook: 8000, whatsapp: 4096 };
  const limit = limits[model.platform || ''];
  return (
    <div className="mx-auto max-w-[760px]">
      <ProofStrip model={model} />
      <div className="bg-muted/20 px-4 py-8"><PhoneChrome>
        <div className="flex items-center gap-3 border-y border-border px-4 py-3"><div className="h-8 w-8 rounded-full bg-primary/10" /><div><p className="text-sm font-semibold">{model.recipient || "Recipient"}</p><p className="text-[10px] text-muted-foreground">Message preview</p></div></div>
        <div className="min-h-[360px] bg-background p-4"><div className="ml-auto max-w-[88%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-5 text-primary-foreground">{model.message || "Your direct message will appear here."}</div><div className="mt-2 text-right text-[10px] text-muted-foreground">Not sent</div></div>
      </PhoneChrome>
        <p className={cn("mt-3 text-center text-xs", limit && model.message.length > limit ? 'text-destructive' : 'text-muted-foreground')}>{model.message.length}{limit ? `/${limit}` : ''} characters · {model.platform === 'all' ? 'Choose a destination before outreach' : 'Connection and recipient checked in outreach'}</p>
        <VariableProof text={model.message} />
      </div>
    </div>
  );
}

function AdPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "ad" }> }) {
  return (
    <PreviewFrame model={model}>
      <div className="flex items-center gap-3 px-5 py-4"><div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">A</div><div><p className="text-sm font-semibold">{model.brand || "Your brand"}</p><p className="text-xs text-muted-foreground">Promoted</p></div></div>
      <p className="whitespace-pre-wrap px-5 pb-4 text-sm leading-6">{model.body || "Your primary ad copy will appear here."}</p>
      {model.mediaUrl ? <img src={normalizeUploadUrl(model.mediaUrl)} alt="Ad creative preview" className="aspect-video w-full bg-muted object-cover" /> : <EmptyMedia label="Generate or attach media to complete the ad proof." />}
      <div className="flex items-center justify-between gap-4 border-t border-border bg-muted/25 px-5 py-4"><div className="min-w-0"><p className="text-[10px] uppercase text-muted-foreground">{model.productUrl || "Landing page not set"}</p><p className="truncate text-base font-semibold">{model.headline || model.title || "Your ad headline"}</p></div>{model.cta && <span className="shrink-0 rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold">{model.cta}</span>}</div>
    </PreviewFrame>
  );
}

function ImagePreview({ model }: { model: Extract<CreatorPreviewModel, { format: "image" }> }) {
  return (
    <PreviewFrame model={model}>
      {model.sourceUrl ? <img src={normalizeUploadUrl(model.sourceUrl)} alt="Image proof" className="max-h-[600px] w-full bg-muted object-contain" /> : <EmptyMedia label={model.prompt || "Describe the image and its composition to begin the proof."} />}
      <div className="border-t border-border px-5 py-4"><p className="text-xs font-semibold text-foreground">Creative direction</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{model.prompt || "No prompt entered yet."}</p></div>
    </PreviewFrame>
  );
}

/** "9:16" → "9 / 16" so the preview box matches the video instead of cropping it. */
export function cssAspectRatio(aspectRatio?: string): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(aspectRatio?.trim() || "");
  return match ? `${match[1]} / ${match[2]}` : "16 / 9";
}

function VideoPreview({ model }: { model: Extract<CreatorPreviewModel, { format: "video" }> }) {
  return (
    <PreviewFrame model={model}>
      <div className="relative">
        {model.videoUrl ? <div className="flex justify-center bg-black"><video src={normalizeUploadUrl(model.videoUrl)} controls className="max-h-[70vh] w-full bg-black object-contain" style={{ aspectRatio: cssAspectRatio(model.aspectRatio) }} /></div> : model.startFrameUrl ? <img src={normalizeUploadUrl(model.startFrameUrl)} alt="Video reference image" className="aspect-video w-full bg-muted object-contain" /> : <EmptyMedia label={model.prompt || "Describe the opening shot and motion to begin the video proof."} icon={MonitorPlay} />}
        {!model.videoUrl && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="flex h-14 w-14 items-center justify-center rounded-full bg-card/90 shadow-md"><Play className="ml-1 h-6 w-6 text-primary" /></span></div>}
      </div>
      <div className="border-t border-border px-5 py-4"><p className="text-xs font-semibold text-foreground">Sequence direction</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{model.prompt || "No prompt entered yet."}</p></div>
    </PreviewFrame>
  );
}

export function CreatorPreview({ model }: { model: CreatorPreviewModel }) {
  return <div className="space-y-4">
    {model.error && model.status === "ready" && <Callout tone="danger" className="mx-auto max-w-[760px]">{model.error} Your previous result is still shown below.</Callout>}
    <PreviewContent model={model} />
  </div>;
}

function PreviewContent({ model }: { model: CreatorPreviewModel }) {
  if (model.status === "empty" || model.status === "failed") return (
    <div className="mx-auto flex min-h-[360px] w-full max-w-[760px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-8 py-12 text-center" role={model.status === "failed" ? "alert" : undefined}>
      <div className="mb-5 rounded-xl border border-border bg-background p-3 text-muted-foreground">{model.status === "failed" ? <AlertCircle className="h-6 w-6 text-destructive" /> : <Sparkles className="h-6 w-6" />}</div>
      <h2 className="text-lg font-semibold">{model.status === "failed" ? "Generation failed" : "Your preview will appear here"}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{model.status === "failed" ? model.error || "Try generating again. Your prompt is still in the editor." : "Enter a prompt and select Generate to create a draft. Writing a prompt does not change the preview."}</p>
      {model.status === 'empty' && <div className="mt-6 max-w-md rounded-lg border border-border bg-background p-4 text-left"><p className="text-xs font-semibold">Build a useful brief</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{COMPOSITION_GUIDE[model.format]}</p></div>}
      {model.status === "empty" && <p className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">Prefer to create it yourself? Switch to manual mode for a live preview.</p>}
    </div>
  );
  if (model.status === "generating") return <GeneratingPreview model={model} />;
  if (model.format === "social") return <SocialPreview model={model} />;
  if (model.format === "blog") return <BlogPreview model={model} />;
  if (model.format === "email") return <EmailPreview model={model} />;
  if (model.format === "sms") return <SmsPreview model={model} />;
  if (model.format === "dm") return <DmPreview model={model} />;
  if (model.format === "ad") return <AdPreview model={model} />;
  if (model.format === "image") return <ImagePreview model={model} />;
  return <VideoPreview model={model} />;
}
