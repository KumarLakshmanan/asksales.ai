"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bookmark,
  ExternalLink,
  Eye,
  Facebook,
  Heart,
  Instagram,
  MessageCircle,
  MousePointerClick,
  Send,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BRAND_URL } from "@/lib/brand";
import { type AdCreativePreview as AdCreativePreviewData } from "../../../../shared/adCreativePreview";
export type { AdCreativePreviewData };

export interface PreviewableProviderAd {
  id: string;
  name: string;
  effectiveStatus?: string;
  creative?: AdCreativePreviewData;
}

export interface ProviderAccountIdentity {
  platform?: string;
  adAccountId?: string | null;
  adAccountName?: string | null;
  facebookPageName?: string | null;
  facebookPageId?: string | null;
  instagramUsername?: string | null;
  instagramAccountId?: string | null;
  instagramProfilePicture?: string | null;
}

interface AdCreativePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopeName: string;
  scopeType: "campaign" | "ad set" | "ad";
  ads: PreviewableProviderAd[];
  initialAdId?: string;
  identity?: ProviderAccountIdentity | null;
}

type Placement = "facebook" | "instagram";

function safePreviewUrl(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, BRAND_URL);
    return ["http:", "https:"].includes(parsed.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readableCta(value?: string) {
  if (!value) return "Learn more";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function destinationLabel(value?: string) {
  const safeValue = safePreviewUrl(value);
  if (!safeValue) return "Destination unavailable";
  try {
    return new URL(safeValue, BRAND_URL).hostname.replace(/^www\./, "") || "Destination available";
  } catch {
    return "Destination available";
  }
}

function hasCreativeEvidence(creative?: AdCreativePreviewData) {
  return Boolean(
    creative?.primaryText ||
    creative?.headline ||
    creative?.description ||
    creative?.imageUrl ||
    creative?.thumbnailUrl ||
    creative?.destinationUrl ||
    creative?.callToActionType,
  );
}

function CreativeMedia({ creative, adName }: { creative?: AdCreativePreviewData; adName: string }) {
  const urls = [...new Set([safePreviewUrl(creative?.imageUrl), safePreviewUrl(creative?.thumbnailUrl)].filter((url): url is string => Boolean(url)))];
  return <SavedCreativeMedia key={JSON.stringify(urls)} urls={urls} adName={adName} />;
}

function SavedCreativeMedia({ urls, adName }: { urls: string[]; adName: string }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const mediaUrl = urls.find(url => !failedUrls.includes(url));
  if (mediaUrl) {
    return (
      <img
        src={mediaUrl}
        alt={`Creative for ${adName}`}
        className="h-full w-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrls(failed => failed.includes(mediaUrl) ? failed : [...failed, mediaUrl])}
      />
    );
  }
  return (
    <div role="status" className="flex h-full min-h-64 flex-col items-center justify-center bg-[linear-gradient(145deg,hsl(var(--muted)),hsl(var(--background)))] px-8 text-center">
      <Eye className="h-8 w-8 text-muted-foreground/65" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium">Media preview unavailable</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
        {urls.length ? 'The saved provider media links could not be loaded. Review the Meta connection and refresh reporting evidence to update this preview. The live ad was not changed.' : 'The latest provider evidence did not include an image or video thumbnail.'}
      </p>
    </div>
  );
}

function FacebookPlacement({ ad, identity }: { ad: PreviewableProviderAd; identity?: ProviderAccountIdentity | null }) {
  const creative = ad.creative;
  const advertiser = identity?.facebookPageName || identity?.facebookPageId || "Facebook advertiser unavailable";
  return (
    <article aria-label={`Facebook preview for ${ad.name}`} className="mx-auto w-full max-w-[560px] overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1877f2] text-white">
          <Facebook className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{advertiser}</p>
          <p className="text-xs text-muted-foreground">Sponsored · Public</p>
        </div>
      </div>
      <p className="whitespace-pre-wrap px-4 pb-3 text-sm leading-6">
        {creative?.primaryText || "Primary ad text was not included in the latest provider evidence."}
      </p>
      <div className="aspect-[1.2/1] overflow-hidden border-y bg-muted/30">
        <CreativeMedia creative={creative} adName={ad.name} />
      </div>
      <div className="flex items-center justify-between gap-4 bg-muted/30 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {destinationLabel(creative?.destinationUrl)}
          </p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold">{creative?.headline || ad.name}</p>
          {creative?.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{creative.description}</p>}
        </div>
        <span className="shrink-0 rounded-md border bg-background px-3 py-2 text-xs font-semibold">
          {readableCta(creative?.callToActionType)}
        </span>
      </div>
      <div className="grid grid-cols-3 border-t px-3 py-2 text-xs font-medium text-muted-foreground">
        <span className="text-center">Like</span><span className="text-center">Comment</span><span className="text-center">Share</span>
      </div>
    </article>
  );
}

function InstagramPlacement({ ad, identity }: { ad: PreviewableProviderAd; identity?: ProviderAccountIdentity | null }) {
  const creative = ad.creative;
  const advertiser = identity?.instagramUsername ? `@${identity.instagramUsername.replace(/^@/, "")}` : identity?.instagramAccountId || "Instagram identity unavailable";
  return (
    <article aria-label={`Instagram preview for ${ad.name}`} className="mx-auto w-full max-w-[440px] overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)] text-white">
          <Instagram className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{advertiser}</p>
          <p className="text-[11px] text-muted-foreground">Sponsored</p>
        </div>
      </div>
      <div className="aspect-[4/5] overflow-hidden border-y bg-muted/30">
        <CreativeMedia creative={creative} adName={ad.name} />
      </div>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-4"><Heart className="h-5 w-5"/><MessageCircle className="h-5 w-5"/><Send className="h-5 w-5"/></div>
        <Bookmark className="h-5 w-5" />
      </div>
      <div className="px-4 pb-4 text-sm leading-5">
        <p><span className="font-semibold">{advertiser}</span> {creative?.primaryText || "Primary ad text was not included in the latest provider evidence."}</p>
        {creative?.headline && <p className="mt-2 font-semibold">{creative.headline}</p>}
        <div className="mt-3 flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs font-semibold">
          <span>{readableCta(creative?.callToActionType)}</span><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      </div>
    </article>
  );
}

export function AdCreativePreviewDialog({
  open,
  onOpenChange,
  scopeName,
  scopeType,
  ads,
  initialAdId,
  identity,
}: AdCreativePreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] max-w-6xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle className="truncate">Creative preview · {scopeName}</DialogTitle>
          <DialogDescription>Read-only provider preview for this {scopeType}. No delivery settings are changed.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AdCreativePreviewWorkspace ads={ads} initialAdId={initialAdId} scopeType={scopeType} identity={identity}/>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AdCreativePreviewWorkspace({
  ads,
  initialAdId,
  identity,
  scopeType = "campaign",
  compact = false,
}: {
  ads: PreviewableProviderAd[];
  initialAdId?: string;
  identity?: ProviderAccountIdentity | null;
  scopeType?: "campaign" | "ad set" | "ad";
  compact?: boolean;
}) {
  const [placement, setPlacement] = useState<Placement>("facebook");
  const [selectedAdId, setSelectedAdId] = useState(initialAdId || ads[0]?.id || "");

  useEffect(() => {
    setSelectedAdId(initialAdId || ads[0]?.id || "");
  }, [ads, initialAdId]);

  const selectedAd = useMemo(
    () => ads.find((ad) => ad.id === selectedAdId) || ads[0],
    [ads, selectedAdId],
  );
  const evidenceCount = ads.filter((ad) => hasCreativeEvidence(ad.creative)).length;
  const creativePage = selectedAd?.creative?.facebookPageId;
  const creativeInstagram = selectedAd?.creative?.instagramAccountId;
  const selectedIdentity = { ...identity,
    ...(creativePage ? { facebookPageId: creativePage, facebookPageName: identity?.facebookPageId === creativePage ? identity?.facebookPageName : null } : {}),
    ...(creativeInstagram ? { instagramAccountId: creativeInstagram, instagramUsername: identity?.instagramAccountId === creativeInstagram ? identity?.instagramUsername : null } : {}),
  };


  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <p className="text-sm text-muted-foreground">Approximate placements from cached, read-only provider evidence.</p>
        <Badge variant="outline">{evidenceCount}/{ads.length} have saved creative evidence</Badge>
      </div>
        {!ads.length ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
            <Eye className="h-9 w-9 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">No ads are available to preview</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Expand or synchronize the campaign hierarchy after reconnecting the provider. Preview never starts a sync or changes the campaign.
            </p>
          </div>
        ) : (
          <div className={cn("grid min-w-0", !compact && "lg:grid-cols-[280px_minmax(0,1fr)]")}>
            <aside className={cn("border-b bg-muted/20 p-3", !compact && "lg:border-b-0 lg:border-r")} aria-label="Ads in preview">
              <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Ads in this {scopeType}</p>
              <div className={compact ? undefined : "lg:hidden"}>
                <Select value={selectedAd?.id} onValueChange={setSelectedAdId}>
                  <SelectTrigger aria-label="Creative"><SelectValue placeholder="Select a creative"/></SelectTrigger>
                  <SelectContent>{ads.map(ad => <SelectItem key={ad.id} value={ad.id}>{ad.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className={compact ? "hidden" : "hidden gap-2 lg:flex lg:flex-col"}>
                {ads.map((ad) => (
                  <button
                    key={ad.id}
                    type="button"
                    onClick={() => setSelectedAdId(ad.id)}
                    aria-pressed={selectedAd?.id === ad.id}
                    className={cn(
                      "min-w-56 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0",
                      selectedAd?.id === ad.id ? "border-primary bg-background shadow-sm" : "border-transparent hover:border-border hover:bg-background/70",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm font-medium">{ad.name}</p>
                      <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", hasCreativeEvidence(ad.creative) ? "bg-emerald-500" : "bg-amber-500")} aria-hidden="true" />
                    </div>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">{ad.effectiveStatus?.toLowerCase() || "status unavailable"}</p>
                  </button>
                ))}
              </div>
            </aside>

            <section className={cn("min-w-0 bg-muted/10 p-4", !compact && "sm:p-6")} aria-label="Creative placement preview">
              <div className={cn("mx-auto mb-4 flex max-w-[560px] flex-col gap-3", !compact && "sm:flex-row sm:items-center sm:justify-between")}>
                <div>
                  <p className="text-sm font-semibold">{selectedAd?.name}</p>
                  <p className="text-xs text-muted-foreground">Approximate placement using the latest provider creative evidence.</p>
                </div>
                <div className="flex w-full flex-wrap rounded-lg border bg-background p-1 sm:w-fit" aria-label="Preview placement">
                  <Button type="button" size="sm" variant={placement === "facebook" ? "secondary" : "ghost"} onClick={() => setPlacement("facebook")} aria-pressed={placement === "facebook"}>
                    <Facebook className="mr-1.5 h-4 w-4"/>Facebook
                  </Button>
                  <Button type="button" size="sm" variant={placement === "instagram" ? "secondary" : "ghost"} onClick={() => setPlacement("instagram")} aria-pressed={placement === "instagram"}>
                    <Instagram className="mr-1.5 h-4 w-4"/>Instagram
                  </Button>
                </div>
              </div>

              {selectedAd && (placement === "facebook" ? <FacebookPlacement ad={selectedAd} identity={selectedIdentity}/> : <InstagramPlacement ad={selectedAd} identity={selectedIdentity}/>)}

              {selectedAd && ((placement === "facebook" && !identity?.facebookPageName && !identity?.adAccountName) || (placement === "instagram" && !identity?.instagramUsername)) && (
                <Callout tone="warning" size="sm" className="mx-auto mt-4 max-w-[560px]">
                  Provider evidence did not include the connected {placement === "facebook" ? "Facebook Page name" : "Instagram username"}. The creative name is intentionally not used as the advertiser identity.
                </Callout>
              )}

              {selectedAd && !hasCreativeEvidence(selectedAd.creative) && (
                <Callout tone="warning" size="sm" icon={MousePointerClick} className="mx-auto mt-4 max-w-[560px]">
                  This ad is visible in the delivery hierarchy, but its copy and media were not included in the latest cached provider evidence. Reconnect and synchronize Meta to populate the preview.
                </Callout>
              )}
            </section>
          </div>
        )}
    </div>
  );
}
