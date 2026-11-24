"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircle, Megaphone, RefreshCw } from "lucide-react";
import type { WidgetProps } from "./types";
import api from "@/lib/api";
import { campaignCurrencyScale, type CampaignPublishReview, type ReviewedAdPlatform } from "../../../../shared/adCampaignReview";

export function toCampaignDateTimeLocal(value?: string | Date): string {
  if (!value) return "";
  const date = value instanceof Date ? value : campaignUtcDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

// Zone-free review fields are explicitly UTC, never browser-local time.
function campaignUtcDate(value: string): Date {
  const normalized = value.trim();
  return new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)
    ? `${normalized}Z` : normalized);
}

export function defaultCampaignSchedule(now = new Date()): { start_date: string; end_date: string } {
  const start = new Date(now.getTime() + 60 * 60 * 1000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 15) * 15);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    start_date: toCampaignDateTimeLocal(start),
    end_date: toCampaignDateTimeLocal(end),
  };
}

export function canonicalCampaignReviewForm(form: Record<string, unknown>): Record<string, unknown> {
  const startDate = String(form.start_date || "");
  const endDate = String(form.end_date || "");
  return {
    ...form,
    placements: Array.isArray(form.placements) && form.placements.length > 0 ? form.placements : ["Automatic"],
    start_date: startDate && Number.isFinite(campaignUtcDate(startDate).getTime()) ? campaignUtcDate(startDate).toISOString() : undefined,
    end_date: endDate && Number.isFinite(campaignUtcDate(endDate).getTime()) ? campaignUtcDate(endDate).toISOString() : undefined,
  };
}

function reviewLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

function ReviewValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">Not set</span>;
  if (Array.isArray(value)) return value.length
    ? <div className="space-y-2">{value.map((item, index) => <div key={index}><ReviewValue value={item} /></div>)}</div>
    : <span className="text-muted-foreground">None</span>;
  if (typeof value === 'object') return <dl className="space-y-1.5">{Object.entries(value).map(([key, item]) => <div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"><dt className="text-muted-foreground">{reviewLabel(key)}</dt><dd className="min-w-0 break-words [overflow-wrap:anywhere]"><ReviewValue value={item} /></dd></div>)}</dl>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return <a href={value} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline underline-offset-2">{value}</a>;
  return <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(value)}</span>;
}

function SavedCampaignReview({ review, platforms, onToggle }: { review: CampaignPublishReview; platforms: ReviewedAdPlatform[]; onToggle: (platform: ReviewedAdPlatform) => void }) {
  const saved = review.snapshot;
  const amount = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: saved.budget.currency }).format(minor / campaignCurrencyScale(saved.budget.currency));
  return <div className="min-w-0 space-y-4" aria-label="Saved campaign review">
    <header className="rounded-lg border border-primary/25 bg-primary/5 p-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Saved campaign #{saved.campaignId} · version {saved.campaignVersion}</p>
      <h3 className="mt-1 break-words text-sm font-semibold">{saved.name}</h3>
      <p className="mt-2 text-lg font-semibold tabular-nums">{amount(saved.budget.amountMinor)} <span className="text-xs font-normal text-muted-foreground">total {saved.budget.budgetType} cap</span></p>
      <p className="mt-1 text-xs text-muted-foreground">The allocations below share this cap; each platform does not receive the full amount.</p>
    </header>
    {review.validationErrors.length > 0 ? <Callout tone="danger" size="sm" title="Resolve these campaign checks before approval">
      <ul className="list-disc space-y-1 pl-4">{review.validationErrors.map(error => <li key={error}>{error}</li>)}</ul>
    </Callout> : null}
    <dl className="space-y-3 text-xs">
      <div><dt className="mb-1 text-muted-foreground">Objective</dt><dd>{reviewLabel(saved.objective)}</dd></div>
      <div><dt className="mb-1 text-muted-foreground">Landing page</dt><dd><ReviewValue value={saved.landingPageUrl} /></dd></div>
      <div className="grid grid-cols-1 gap-3 @sm/review:grid-cols-2"><div><dt className="text-muted-foreground">Starts (UTC)</dt><dd className="mt-1 break-words">{saved.startDate}</dd></div><div><dt className="text-muted-foreground">Ends (UTC)</dt><dd className="mt-1 break-words">{saved.endDate || 'Not set'}</dd></div></div>
      <div><dt className="mb-1 text-muted-foreground">Locations and targeting</dt><dd className="rounded-md border p-2"><ReviewValue value={{ locations: saved.locations, targeting: saved.targeting, scheduleDates: saved.scheduleDates }} /></dd></div>
    </dl>
    {saved.platforms.map(platform => <section key={platform} className="min-w-0 rounded-lg border p-3 text-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{platform === 'meta' ? 'Meta Ads' : 'Google Ads'}</h4><Button type="button" size="sm" variant={platforms.includes(platform) ? 'default' : 'outline'} aria-pressed={platforms.includes(platform)} onClick={() => onToggle(platform)} className="h-7 text-xs">{platforms.includes(platform) ? 'Selected' : 'Not selected'} {platform === 'meta' ? 'Meta' : 'Google'}</Button></div>
      <p className="mb-3 font-medium tabular-nums">Platform allocation: {amount(saved.allocations.filter(item => item.platform === platform).reduce((sum, item) => sum + item.amountMinor, 0))}</p>
      <p className="mb-1 font-medium">Account and identity</p><ReviewValue value={saved.providerAccounts[platform]} />
      {review.platformErrors?.[platform]?.length ? <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-300"><p className="font-medium">This platform needs attention</p><ul className="mt-1 list-disc space-y-1 pl-4">{review.platformErrors[platform]!.map(error => <li key={error}>{error}</li>)}</ul></div> : null}
      <details className="mt-3 border-t pt-2" open><summary className="cursor-pointer font-medium">Spend, placement and policy settings</summary><div className="mt-2"><ReviewValue value={{ allocations: saved.allocations.filter(item => item.platform === platform), providerSettings: saved.providerConfig[platform] }} /></div></details>
      <details className="mt-3 border-t pt-2" open><summary className="cursor-pointer font-medium">Exact creative · revision {saved.creativeRevision}</summary><div className="mt-2 space-y-3"><ReviewValue value={saved.creatives[platform]} /><ReviewValue value={{ sourceVersions: saved.creativeSources }} /></div></details>
    </section>)}
    <p className="break-all font-mono text-[10px] text-muted-foreground" title={review.revision}>Review revision {review.revision}</p>
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5">One approval authorizes creation and live activation only on the selected platforms, using this saved review. If the campaign changes, launch stops for a new review. Queued does not mean active.</div>
  </div>;
}

export function PublishAdsWidget(props: WidgetProps) {
  // Approval state must never survive a switch to a different durable widget.
  // Keying the whole editor also discards in-flight callbacks from the old one.
  return <PublishAdsWidgetEditor key={`${props.widget.threadId}:${props.widget.id}:${props.widget.formValues.campaign_id || 'draft'}`} {...props} />;
}

function PublishAdsWidgetEditor({ widget, onFormChange }: WidgetProps) {
  const [review, setReview] = useState<CampaignPublishReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(Boolean(widget.formValues.campaign_id));
  const isExistingCampaign = Boolean(widget.formValues.campaign_id);
  const initialPlatforms = Array.isArray(widget.formValues.platforms) && widget.formValues.platforms.length > 0
    ? widget.formValues.platforms as Array<"meta" | "google">
    : [widget.toolName === "publish_google_ads" ? "google" : "meta"] as Array<"meta" | "google">;
  const legacyBudgetMajor = Number(widget.formValues.budget || 0);
  const proposedSchedule = defaultCampaignSchedule();
  const [form, setForm] = useState({
    platforms: initialPlatforms,
    campaign_id: (widget.formValues.campaign_id as string) || "",
    asset_ids: (widget.formValues.asset_ids as number[]) || [],
    campaign_name: (widget.formValues.campaign_name as string) || `${initialPlatforms.map(platform => platform === "meta" ? "Meta" : "Google").join(" + ")} Campaign`,
    objective: (widget.formValues.objective as string) || "traffic",
    budget_amount_minor: (widget.formValues.budget_amount_minor as number) || Math.round(legacyBudgetMajor * 100) || 5000,
    currency: (widget.formValues.currency as string) || "USD",
    budget_type: "lifetime" as const,
    landing_url: (widget.formValues.landing_url as string) || "",
    start_date: toCampaignDateTimeLocal(widget.formValues.start_date as string) || proposedSchedule.start_date,
    end_date: toCampaignDateTimeLocal(widget.formValues.end_date as string) || proposedSchedule.end_date,
    placements: Array.isArray(widget.formValues.placements) && widget.formValues.placements.length > 0
      ? widget.formValues.placements as string[]
      : ["Automatic"],
    locations: (widget.formValues.locations as Array<{ countryCode: string; googleGeoTargetId?: string }>) || [],
    provider_account_ids: (widget.formValues.provider_account_ids as { meta?: string; google?: string }) || {},
    creative_revision: (widget.formValues.creative_revision as number) || 1,
    special_ad_categories: (widget.formValues.special_ad_categories as string[]) || [],
  });

  const loadReview = async () => {
    setPreparing(true);
    setReviewError(null);
    try {
      const result = await api.get<{ review: CampaignPublishReview }>(`/api/widgets/${widget.id}/ad-review`);
      validateReview(result.review);
      setReview(result.review);
    } catch (error) {
      setReview(null);
      setReviewError(error instanceof Error ? error.message : 'The saved review could not be loaded.');
    } finally { setPreparing(false); }
  };
  useEffect(() => {
    let current = true;
    if (isExistingCampaign) {
      setPreparing(true);
      setReview(null);
      setReviewError(null);
      void api.get<{ review: CampaignPublishReview }>(`/api/widgets/${widget.id}/ad-review`).then(result => {
        validateReview(result.review);
        if (current) setReview(result.review);
      }).catch(error => {
        if (current) setReviewError(error instanceof Error ? error.message : 'The saved review could not be loaded.');
      }).finally(() => { if (current) setPreparing(false); });
    }
    return () => { current = false; };
  }, [widget.id, isExistingCampaign]);

  function validateReview(value: CampaignPublishReview) {
    if (!/^[a-f0-9]{64}$/.test(value.revision)
      || value.campaignId !== value.snapshot.campaignId
      || (isExistingCampaign && String(value.campaignId) !== String(widget.formValues.campaign_id))
      || form.platforms.some(platform => !value.snapshot.platforms.includes(platform))) {
      throw new Error('The server review does not match the requested campaign and platforms. Reload the correct review before approval.');
    }
  }

  useEffect(() => {
    if (!['active', 'draft'].includes(widget.status)) return;
    const allSelectedBlocked = review && form.platforms.every(platform => (review.platformErrors?.[platform]?.length || 0) > 0);
    onFormChange(review && !preparing ? {
      campaign_id: String(review.campaignId), review_revision: review.revision, platforms: form.platforms,
      _review_validation_error: review.validationErrors.length ? review.validationErrors.join(' ')
        : allSelectedBlocked ? 'Resolve the platform checks above, then prepare a new review.' : undefined,
    } : { ...canonicalCampaignReviewForm({ ...form, campaign_id: form.campaign_id || undefined }),
      _review_validation_error: reviewError || (preparing ? 'Loading the saved campaign review…' : 'Prepare the saved campaign review before approving a launch.'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, review, preparing, reviewError, widget.status]);

  const prepareReview = async () => {
    setPreparing(true);
    setReviewError(null);
    try {
      const response = await api.post<{ review: CampaignPublishReview }>(`/api/widgets/${widget.id}/ad-review`, {
        values: canonicalCampaignReviewForm({ ...form, campaign_id: form.campaign_id || undefined }),
      });
      validateReview(response.review);
      setReview(response.review);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'The review could not be prepared.');
    } finally { setPreparing(false); }
  };

  const updateField = (field: string, value: unknown) => setForm((current) => ({ ...current, [field]: value }));
  const budgetMajor = (form.budget_amount_minor / campaignCurrencyScale(form.currency)).toFixed(form.currency === 'JPY' ? 0 : 2);
  const targetPlatform = form.platforms.map(platform => platform === "meta" ? "Meta Ads" : "Google Ads").join(" + ");
  const togglePlatform = (platform: "meta" | "google") => {
    setForm(current => {
      const selected = current.platforms.includes(platform);
      if (selected && current.platforms.length === 1) return current;
      return {
        ...current,
        platforms: selected
          ? current.platforms.filter(value => value !== platform)
          : [...current.platforms, platform],
      };
    });
  };

  if (review && !preparing) return <div className="space-y-3">
    <SavedCampaignReview review={review} platforms={form.platforms} onToggle={togglePlatform} />
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" onClick={loadReview}><RefreshCw className="mr-2 h-3 w-3" />Reload review</Button>
      {!isExistingCampaign ? <Button type="button" variant="ghost" size="sm" onClick={() => setReview(null)}>Edit draft settings</Button> : <a href={`/dashboard/ads/campaigns/managed/${review.campaignId}`} className="px-2 py-2 text-xs text-primary underline">Open campaign details</a>}
    </div>
  </div>;

  if (isExistingCampaign) return <div className="space-y-3 text-xs">
    {preparing ? <p role="status" className="flex items-center gap-2"><Spinner label={null} />Loading the saved campaign, accounts and creative…</p>
      : <><p role="alert" className="text-destructive">{reviewError || 'The campaign review is unavailable.'}</p><Button type="button" variant="outline" size="sm" onClick={loadReview}>Retry loading review</Button></>}
  </div>;

  return (
    <fieldset disabled={preparing} className="min-w-0 space-y-4">
      <div className="flex items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[9px] border border-border bg-muted/40">
          <Megaphone className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{form.campaign_name}</p>
          <p className="text-xs text-muted-foreground">{targetPlatform} · {form.objective.replaceAll("_", " ")}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Platforms</Label>
          <div className="grid grid-cols-2 gap-2">
            {(["meta", "google"] as const).map(platform => (
              <Button
                key={platform}
                type="button"
                variant={form.platforms.includes(platform) ? "default" : "outline"}
                aria-pressed={form.platforms.includes(platform)}
                onClick={() => togglePlatform(platform)}
                className="h-9 text-xs"
              >
                {platform === "meta" ? "Meta Ads" : "Google Ads"}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`campaign-name-${widget.id}`} className="text-xs font-medium">Campaign Name</Label>
          <Input id={`campaign-name-${widget.id}`} value={form.campaign_name} onChange={(event) => updateField("campaign_name", event.target.value)} className="h-9 text-sm" />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Objective</Label>
          <Select value={form.objective} onValueChange={(value) => updateField("objective", value)}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="awareness">Awareness</SelectItem>
              <SelectItem value="traffic">Traffic</SelectItem>
              <SelectItem value="engagement">Engagement</SelectItem>
              <SelectItem value="leads">Leads</SelectItem>
              <SelectItem value="sales">Sales</SelectItem>
              <SelectItem value="app_promotion">App Promotion</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`campaign-budget-${widget.id}`} className="text-xs font-medium">Lifetime Budget</Label>
            <Input id={`campaign-budget-${widget.id}`} type="number" min="1" step={form.currency === 'JPY' ? '1' : '0.01'} value={budgetMajor} onChange={(event) => updateField("budget_amount_minor", Math.round((Number(event.target.value) || 0) * campaignCurrencyScale(form.currency)))} className="h-9 text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`campaign-currency-${widget.id}`} className="text-xs font-medium">Currency</Label>
            <Input id={`campaign-currency-${widget.id}`} value={form.currency} maxLength={3} onChange={(event) => updateField("currency", event.target.value.toUpperCase())} className="h-9 text-xs" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`campaign-landing-${widget.id}`} className="text-xs font-medium">Landing Page</Label>
          <Input id={`campaign-landing-${widget.id}`} type="url" value={form.landing_url} onChange={(event) => updateField("landing_url", event.target.value)} placeholder="https://example.com/offer" className="h-9 text-xs" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`campaign-placements-${widget.id}`} className="text-xs font-medium">Placements</Label>
          <Input
            id={`campaign-placements-${widget.id}`}
            value={form.placements.join(", ")}
            onChange={(event) => updateField("placements", event.target.value.split(",").map(value => value.trim()).filter(Boolean))}
            placeholder="Automatic, Feed, Search"
            className="h-9 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`campaign-countries-${widget.id}`} className="text-xs font-medium">Target Countries</Label>
          <Input
            id={`campaign-countries-${widget.id}`}
            value={form.locations.map(location => location.countryCode).join(", ")}
            onChange={(event) => updateField("locations", event.target.value.split(",").map(value => value.trim().toUpperCase()).filter(Boolean).map(countryCode => ({ ...form.locations.find(item => item.countryCode === countryCode), countryCode })))}
            placeholder="US, IN"
            className="h-9 text-xs"
          />
        </div>

        {form.platforms.includes('google') ? form.locations.map((location, index) => <div key={`${location.countryCode}-${index}`} className="space-y-1.5"><Label htmlFor={`google-location-${widget.id}-${index}`} className="text-xs">Google location resource · {location.countryCode}</Label><Input id={`google-location-${widget.id}-${index}`} value={location.googleGeoTargetId || ''} placeholder="geoTargetConstants/…" onChange={event => updateField('locations', form.locations.map((item, itemIndex) => itemIndex === index ? { ...item, googleGeoTargetId: event.target.value } : item))} /></div>) : null}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor={`campaign-start-${widget.id}`} className="text-xs font-medium">Start (UTC)</Label><Input id={`campaign-start-${widget.id}`} type="datetime-local" value={form.start_date} onChange={(event) => updateField("start_date", event.target.value)} className="h-9 text-xs" /></div>
          <div className="space-y-1.5"><Label htmlFor={`campaign-end-${widget.id}`} className="text-xs font-medium">End (UTC)</Label><Input id={`campaign-end-${widget.id}`} type="datetime-local" value={form.end_date} onChange={(event) => updateField("end_date", event.target.value)} className="h-9 text-xs" /></div>
        </div>

        <div className="flex items-center justify-between rounded-md bg-muted/50 p-2 text-xs">
          <span className="text-muted-foreground">Approved creative revision</span>
          <Badge variant="secondary">Revision {form.creative_revision} · {form.campaign_id ? `Campaign #${form.campaign_id}` : `Assets ${form.asset_ids.join(", ") || "not selected"}`}</Badge>
        </div>

        <div className="rounded-md border p-2 text-xs">
          <p className="mb-1 font-medium">Provider accounts</p>
          {form.platforms.map(platform => (
            <div key={platform} className="flex justify-between gap-3 text-muted-foreground">
              <span>{platform === "meta" ? "Meta" : "Google"}</span>
              <span className="truncate">{form.provider_account_ids[platform] || "Not selected — launch blocked"}</span>
            </div>
          ))}
        </div>
      </div>

      <Callout tone="warning" size="sm" icon={AlertCircle}>
        Prepare a saved draft first. You will review the exact accounts, creative, provider settings and budget allocation before authorizing activation or spend.
      </Callout>
      {reviewError ? <p role="alert" className="text-xs text-destructive">{reviewError}</p> : null}
      <Button type="button" onClick={prepareReview} loading={preparing} loadingText="Preparing saved review…" className="w-full">Prepare saved campaign review</Button>
    </fieldset>
  );
}
