"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Lightbulb, Plus, Search } from "lucide-react";
import api from "@/lib/api";
import { paidAdsCreativeResearchHref } from "./campaignRoutes";
import { prepareCreativeDraftReview } from "@/lib/creative-draft-review";
import { paidAdAccountNames, type PaidAdAccountIdentity } from "@/lib/paid-ad-accounts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { creativeTestMetric } from "../../../../shared/adCreativeIntelligence";
import type {
  CreativeBrief,
  CreativeResearch,
  CreativeReference,
} from "../../../../shared/adCreativeIntelligence";

interface DiscoveredProfile { pageName: string; sampleAdCount: number; matchedTerms: string[]; libraryUrl: string }
interface ProfileDiscovery { status: string; profiles: DiscoveredProfile[]; message: string }
interface ProfileAds { status: string; references: CreativeReference[]; message: string }
interface PublicAdDetails { status: "succeeded" | "unavailable" | "provider_error"; reach: number | null; reachLocation: string | null; reachBreakdown: Array<{ location: string; ageRange: string; gender: string; reach: number }>; regionalReach?: Array<{ location: string; reach: number }>; engagement: { likes: null; comments: null; shares: null }; message: string }

const base = "/api/campaigns/creative-intelligence";
const blankReference = () => ({
  pageName: "",
  url: "",
  body: "",
  notes: "",
  format: "unknown",
});
const pending = (status?: string) =>
  status === "queued" || status === "running";
const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";
const countryCode = (value: string) => value.trim().toUpperCase() === "UK" ? "GB" : value.trim().toUpperCase();

export function CreativeResearchPanel() {
  const params = useSearchParams();
  const workspaceSearch = params.toString();
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [reload, setReload] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [country, setCountry] = useState("IN");
  const [discovery, setDiscovery] = useState<ProfileDiscovery | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<DiscoveredProfile | null>(null);
  const [profileAds, setProfileAds] = useState<ProfileAds | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [loadingAds, setLoadingAds] = useState(false);
  const [adDetails, setAdDetails] = useState<Record<string, PublicAdDetails>>({});
  const [detailsProgress, setDetailsProgress] = useState({ done: 0, total: 0 });
  const discoveryRequest = useRef(0);
  const adsRequest = useRef(0);
  const [references, setReferences] = useState([blankReference()]);
  const [research, setResearch] = useState<CreativeResearch | null>(null);
  const [brief, setBrief] = useState<CreativeBrief | null>(null);
  const [history, setHistory] = useState<
    Array<{ id: number; title: string; status: string }>
  >([]);
  const [facts, setFacts] = useState("");
  const [audience, setAudience] = useState("");
  const [language, setLanguage] = useState("English");
  const [objective, setObjective] = useState("leads");
  const [landingUrl, setLandingUrl] = useState("");
  const [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Identical transport retries reuse a request ID; changed inputs get a new one.
  const requestKeys = useRef<Record<string, { body: string; id: string }>>({});
  const requestId = (kind: string, body: unknown) => {
    const serialized = JSON.stringify(body);
    if (requestKeys.current[kind]?.body !== serialized)
      requestKeys.current[kind] = { body: serialized, id: crypto.randomUUID() };
    return requestKeys.current[kind].id;
  };
  const report = (cause: unknown) =>
    setError(
      cause instanceof Error
        ? cause.message
        : "Unable to complete the request.",
    );
  const briefId = params.get("creativeBrief");
  const campaignId = params.get("creativeCampaign");
  const researchId = params.get("creativeResearch");
  useEffect(() => {
    let active = true;
    api
      .get<{ enabled: boolean }>(
        `${base}/capabilities`,
      )
      .then((value) => {
        if (active) {
          setEnabled(value.enabled);
        }
      })
      .catch((cause) => {
        if (active) report(cause);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  useEffect(() => {
    if (enabled === null) return;
    let active = true;
    api
      .get<typeof history>(`${base}/briefs`)
      .then((value) => {
        if (active) { setHistory(value); setHistoryLoaded(true); }
      })
      .catch((cause) => {
        if (active) report(cause);
      });
    return () => {
      active = false;
    };
  }, [enabled, brief?.status, reload]);
  useEffect(() => {
    if (!historyLoaded || briefId || researchId || brief || research || campaignId) return;
    const latest = history[0];
    if (latest) router.replace(paidAdsCreativeResearchHref(workspaceSearch, { briefId: latest.id }), { scroll: false });
  }, [historyLoaded, history, briefId, researchId, brief, research, campaignId, router, workspaceSearch]);
  useEffect(() => {
    if (!researchId || !/^\d+$/.test(researchId)) return;
    let active = true;
    api.get<CreativeResearch>(`${base}/research/${researchId}`)
      .then((value) => { if (active) setResearch(value); })
      .catch((cause) => { if (active) report(cause); });
    return () => { active = false; };
  }, [researchId, reload]);
  const clearDiscovery = () => {
    discoveryRequest.current += 1;
    adsRequest.current += 1;
    setDiscovery(null);
    setSelectedProfile(null);
    setProfileAds(null);
    setDiscovering(false);
    setLoadingAds(false);
    setAdDetails({});
    setDetailsProgress({ done: 0, total: 0 });
  };
  const fetchProfiles = async () => {
    if (!enabled || discovering) return;
    clearDiscovery();
    const request = discoveryRequest.current;
    setError("");
    setDiscovering(true);
    try {
      const value = await api.get<ProfileDiscovery>(`${base}/competitor-profiles`);
      if (request === discoveryRequest.current) setDiscovery(value);
    } catch (cause) {
      if (request === discoveryRequest.current) report(cause);
    } finally {
      if (request === discoveryRequest.current) setDiscovering(false);
    }
  };
  const openProfile = async (profile: DiscoveredProfile) => {
    const request = discoveryRequest.current;
    const adRequest = ++adsRequest.current;
    setSelectedProfile(profile);
    setProfileAds(null);
    setAdDetails({});
    setDetailsProgress({ done: 0, total: 0 });
    setLoadingAds(true);
    setError("");
    try {
      const value = await api.get<ProfileAds>(`${base}/competitor-profiles/${encodeURIComponent(profile.pageName)}/ads`);
      if (request === discoveryRequest.current && adRequest === adsRequest.current) {
        setProfileAds(value);
        const ads = value.references.filter((ad) => /^\d{6,40}$/.test(ad.id));
        setDetailsProgress({ done: 0, total: ads.length });
        let next = 0;
        const worker = async () => {
          while (next < ads.length && request === discoveryRequest.current && adRequest === adsRequest.current) {
            const ad = ads[next++];
            try {
              const detail = await api.get<PublicAdDetails>(`${base}/competitor-ads/${ad.id}/details`);
              if (request === discoveryRequest.current && adRequest === adsRequest.current) setAdDetails((current) => ({ ...current, [ad.id]: detail }));
            } catch {
              if (request === discoveryRequest.current && adRequest === adsRequest.current) setAdDetails((current) => ({ ...current, [ad.id]: { status: "provider_error", reach: null, reachLocation: null, reachBreakdown: [], engagement: { likes: null, comments: null, shares: null }, message: "Detail inspection failed. Open the ad or retry later." } }));
            } finally {
              if (request === discoveryRequest.current && adRequest === adsRequest.current) setDetailsProgress((current) => ({ ...current, done: current.done + 1 }));
            }
          }
        };
        void Promise.all(Array.from({ length: Math.min(2, ads.length) }, worker));
      }
    } catch (cause) { if (request === discoveryRequest.current && adRequest === adsRequest.current) report(cause); }
    finally { if (request === discoveryRequest.current && adRequest === adsRequest.current) setLoadingAds(false); }
  };
  useEffect(() => {
    if (!briefId || !/^\d+$/.test(briefId)) return;
    let active = true;
    api
      .get<CreativeBrief>(`${base}/briefs/${briefId}`)
      .then((value) => {
        if (active) setBrief(value);
      })
      .catch((cause) => {
        if (active) report(cause);
      });
    return () => {
      active = false;
    };
  }, [briefId]);
  useEffect(() => {
    if (!pending(research?.status) && !pending(brief?.status)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (research && pending(research.status)) {
          const value = await api.get<CreativeResearch>(
            `${base}/research/${research.id}`,
          );
          if (active) setResearch(value);
        }
        if (brief && pending(brief.status)) {
          const value = await api.get<CreativeBrief>(
            `${base}/briefs/${brief.id}`,
          );
          if (active) setBrief(value);
        }
      } catch (cause) {
        if (active) report(cause);
      }
      if (active) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [research, brief]);

  useEffect(() => {
    if (research && !pending(research.status))
      delete requestKeys.current.research;
    if (brief && !pending(brief.status)) delete requestKeys.current.brief;
  }, [research, brief]);

  const startResearch = async () => {
    setBusy(true);
    setError("");
    setBrief(null);
    try {
      const body = {
        source: "manual",
        country,
        references: references.map((ref) => ({
          ...ref,
          url: ref.url.trim() || undefined,
        })),
      };
      const value = await api.post<CreativeResearch>(`${base}/research`, {
        ...body,
        requestId: requestId("research", body),
      });
      setResearch(value);
      router.replace(
        paidAdsCreativeResearchHref(workspaceSearch, { researchId: value.id }),
        { scroll: false },
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const suggest = async () => {
    if (!research) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        researchRunIds: [research.id],
        businessFacts: facts,
        audience,
        objective,
        language,
        country,
        landingUrl: landingUrl.trim() || undefined,
        constraints,
        ...(campaignId ? { campaignId: Number(campaignId) } : {}),
      };
      const value = await api.post<CreativeBrief>(`${base}/briefs`, {
        ...body,
        requestId: requestId("brief", body),
      });
      setBrief(value);
      router.replace(
        paidAdsCreativeResearchHref(workspaceSearch, { briefId: value.id }),
        { scroll: false },
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (conceptId: string) => {
    if (!brief) return;
    setBusy(true);
    setError("");
    try {
      setBrief(
        await api.patch<CreativeBrief>(`${base}/briefs/${brief.id}`, {
          revision: brief.revision,
          conceptId,
        }),
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const openDraftReview = async () => {
    if (!brief) return;
    setBusy(true);
    setError("");
    try { router.push(await prepareCreativeDraftReview(brief)); }
    catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  return (
    <Card id="creative-research">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5" />
          Competitor creative research
        </CardTitle>
        <CardDescription>
          Turn competitor observations into original ad concepts for your
          business. Review a concept before creating an ad draft.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p
            role="alert"
            className="rounded border border-destructive/40 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {enabled === null && !error && (
          <p role="status">Loading creative research…</p>
        )}
        {enabled === false && (
          <p role="status" className="rounded border p-3 text-sm">
            New competitor research is not enabled for this workspace yet. Ask
            your administrator to complete setup and enable research. Saved
            suggestions remain available below.
          </p>
        )}
        {(error || enabled === false) && (
          <Button variant="outline" onClick={() => {
            setError("");
            setReload((value) => value + 1);
          }}>Check availability again</Button>
        )}
        {enabled && historyLoaded && history.length === 0 && !brief && !research && (
          <p className="rounded bg-muted p-3 text-sm">
            No competitor suggestions yet. Add an observed ad below, save your
            research, then describe your offer to generate campaign ideas.
            Manual research does not require a connected ad account.
          </p>
        )}
        {history.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="creative-history">Saved briefs</Label>
            <select
              id="creative-history"
              className={selectClass}
              value={briefId || (brief ? String(brief.id) : "")}
              onChange={(event) =>
                router.replace(
                  paidAdsCreativeResearchHref(workspaceSearch, { briefId: event.target.value }),
                  { scroll: false },
                )
              }
            >
              <option value="">Choose a saved brief</option>
              {history.map((item) => (
                <option key={item.id} value={item.id}>
                  #{item.id} · {(item.title || "Saved creative brief").slice(0, 70)} · {item.status}
                </option>
              ))}
            </select>
          </div>
        )}
        {enabled && (
          <>
            {campaignId && (
              <p className="text-sm">
                Using stored evidence from campaign #{campaignId}.
              </p>
            )}
            <section aria-label="Matching advertiser profiles" className="space-y-3 rounded-lg border p-4">
              <div>
                <h3 className="font-medium">Matching advertiser profiles</h3>
                <p className="text-sm text-muted-foreground">Search active, All ads in India using keywords from your approved business profile. These advertisers are candidates; inspect their public ads before comparing creative.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" loading={discovering} loadingText="Fetching profiles…" onClick={() => void fetchProfiles()}>
                  {discovery ? "Fetch profiles again" : "Fetch competitor profiles"}
                </Button>
                <Button asChild type="button" variant="outline"><a href="https://business.facebook.com/ads/library/?active_status=active&ad_type=all&country=IN&is_targeted_country=false&media_type=all" target="_blank" rel="noopener noreferrer">Open public Meta Ads Library</a></Button>
              </div>
              {discovering && <p role="status" className="text-sm">Finding matching advertiser profiles…</p>}
              {discovery && <p role="status" className="text-sm">{discovery.message}</p>}
              {discovery?.profiles.map((profile) => (
                <div key={profile.pageName} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm">
                  <div><p className="font-medium">{profile.pageName}</p><p className="text-muted-foreground">Matched {profile.matchedTerms.join(", ")} · {profile.sampleAdCount} ads in discovery sample</p></div>
                  <Button type="button" variant="outline" size="sm" disabled={loadingAds} onClick={() => void openProfile(profile)}>Fetch ads</Button>
                </div>
              ))}
              {selectedProfile && <div className="space-y-3 rounded bg-muted/40 p-3">
                <div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">{selectedProfile.pageName} ads</h4><a href={selectedProfile.libraryUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open advertiser search in Meta Ads Library</a></div>
                {loadingAds && <p role="status">Loading ads…</p>}
                {detailsProgress.total > 0 && detailsProgress.done < detailsProgress.total && <p role="status" className="text-sm">Inspecting ad details: {detailsProgress.done} of {detailsProgress.total}</p>}
                {profileAds && <><p className="text-sm">{profileAds.message} Each ad detail is checked for Transparency by location. Meta does not expose likes, comments, shares, CTR, spend, conversions, CPA or ROAS for these commercial competitor ads.</p>
                  {!!profileAds.references.length && <div className="rounded border bg-background p-3 text-sm"><p className="font-medium">Creative suggestion from this evidence</p><p>Review the advertiser&apos;s opening message, offer, and call to action. Test one distinct message for your own audience, then compare results from your connected ad account. The public ad sample cannot identify a winning competitor campaign.</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { const ad = profileAds.references[0]; setCountry("IN"); setReferences([{ pageName: ad.pageName, url: ad.url || "", body: ad.bodies.join("\n"), notes: "Observed on public Meta Ad Library; verify before saving.", format: "unknown" }]); }}>Add observed ad to research</Button></div>}
                  {profileAds.references.map((ad) => { const detail = adDetails[ad.id]; return <article key={ad.id} className="rounded border bg-background p-3 text-sm">
                    <p className="font-medium">{ad.titles[0] || ad.pageName}</p>
                    <p className="mt-1 whitespace-pre-wrap">{ad.bodies.join("\n") || ad.descriptions.join("\n") || "Ad copy unavailable"}</p>
                    <p className="mt-2 text-muted-foreground">Format: {ad.format === "unknown" ? "unavailable" : ad.format}</p>
                    <p className="text-muted-foreground">Likes/reactions: {ad.engagement?.likes?.toLocaleString() ?? "unavailable"} · Comments: {ad.engagement?.comments?.toLocaleString() ?? "unavailable"} · Shares: {ad.engagement?.shares?.toLocaleString() ?? "unavailable"}</p>
                    {detail ? <div className="mt-2 rounded bg-muted/40 p-2 text-sm"><p>{detail.message}</p>{detail.reach != null && <p className="font-medium">Estimated reach{detail.reachLocation ? ` in ${detail.reachLocation}` : ""}: {detail.reach.toLocaleString()}</p>}{detail.regionalReach?.filter((region) => region.location !== detail.reachLocation).map((region) => <p key={region.location} className="font-medium">Estimated reach in {region.location}: {region.reach.toLocaleString()}</p>)}{detail.reachBreakdown.length > 0 && <details><summary className="cursor-pointer">Reach by location, age and gender</summary><ul className="mt-1 max-h-48 overflow-y-auto text-xs">{detail.reachBreakdown.map((row, index) => <li key={index}>{row.location} · {row.ageRange} · {row.gender}: {row.reach.toLocaleString()}</li>)}</ul></details>}</div> : <p className="mt-2 text-muted-foreground">Ad details pending…</p>}
                    <p className="mt-2 text-muted-foreground">{ad.platforms.join(", ") || "Platform unavailable"} · Started {ad.startDate ? new Date(ad.startDate).toLocaleDateString() : "unknown"}{ad.endDate ? ` · Ended ${new Date(ad.endDate).toLocaleDateString()}` : ""}</p>
                    {ad.estimatedEuReach != null && <p className="text-muted-foreground">Estimated EU reach: {ad.estimatedEuReach.toLocaleString()}</p>}
                    <div className="mt-3 flex flex-wrap gap-3">
                      {ad.url && <a href={ad.url} target="_blank" rel="noopener noreferrer" className="underline">View ad in Meta Ads Library</a>}
                      <Button asChild type="button" size="sm" variant="outline"><Link href={`/dashboard/ads/create?${new URLSearchParams({ sourceAdId: ad.id, sourcePage: ad.pageName, sourceUrl: ad.url || "", sourceFormat: ad.format, sourceCopy: (ad.bodies.join("\n") || ad.descriptions.join("\n")).slice(0, 500) })}`}>Use this format</Link></Button>
                    </div>
                  </article>; })}
                </>}
              </div>}
            </section>
            <fieldset
              className="space-y-4"
              disabled={
                busy || pending(research?.status) || pending(brief?.status)
              }
            >
              <legend className="mb-3 font-medium">Optional: save ad research for creative suggestions</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Research source</p>
                  <p className="text-sm">Add observed public ads manually</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="creative-country">Country code</Label>
                  <Input
                    id="creative-country"
                    maxLength={2}
                    value={country}
                    onChange={(e) => setCountry(countryCode(e.target.value))}
                  />
                </div>
              </div>
              <div className="space-y-3">
                  {references.map((reference, index) => (
                    <div
                      className="space-y-3 rounded-lg border p-4"
                      key={index}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">
                          Reference {index + 1}
                        </p>
                        {references.length > 1 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setReferences((items) =>
                                items.filter((_, i) => i !== index),
                              )
                            }
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">{(
                        [
                          ["pageName", "Competitor name"],
                          ["url", "Public ad URL (optional)"],
                          ["body", "Observed ad copy"],
                          [
                            "notes",
                            "What you observed: hook, visuals, offer or CTA",
                          ],
                        ] as const
                      ).map(([key, label]) => (
                        <div className="space-y-1" key={key}>
                          <Label htmlFor={`reference-${index}-${key}`}>
                            {label}
                          </Label>
                          {key === "body" || key === "notes" ? (
                            <Textarea
                              id={`reference-${index}-${key}`}
                              value={reference[key]}
                              onChange={(e) =>
                                setReferences((items) =>
                                  items.map((item, i) =>
                                    i === index
                                      ? { ...item, [key]: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          ) : (
                            <Input
                              id={`reference-${index}-${key}`}
                              value={reference[key]}
                              onChange={(e) =>
                                setReferences((items) =>
                                  items.map((item, i) =>
                                    i === index
                                      ? { ...item, [key]: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          )}
                        </div>
                      ))}</div>
                      <Label htmlFor={`reference-${index}-format`}>
                        Observed format
                      </Label>
                      <select
                        id={`reference-${index}-format`}
                        className={selectClass}
                        value={reference.format}
                        onChange={(e) =>
                          setReferences((items) =>
                            items.map((item, i) =>
                              i === index
                                ? { ...item, format: e.target.value }
                                : item,
                            ),
                          )
                        }
                      >
                        {["unknown", "image", "video", "carousel"].map(
                          (format) => (
                            <option key={format} value={format}>
                              {format}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={references.length >= 8}
                    onClick={() =>
                      setReferences((items) => [...items, blankReference()])
                    }
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add competitor reference
                  </Button>
              </div>
              <Button
                onClick={startResearch}
                disabled={
                  !/^[A-Z]{2}$/.test(country) ||
                  references.some((ref) => !ref.pageName.trim() || (!ref.body.trim() && !ref.notes.trim()))
                }
              >
                <Search className="mr-2 h-4 w-4" />
                Save research
              </Button>
            </fieldset>
          </>
        )}
        {research && (
          <section aria-label="Research evidence" className="space-y-3">
            <p role="status" className="text-sm">
              Research #{research.id}: {research.status.replaceAll("_", " ")}.{" "}
              {research.message}
            </p>
            {research.references.slice(0, 30).map((ref) => (
              <details key={ref.id} className="rounded border p-3 text-sm">
                <summary className="cursor-pointer font-medium">
                  {ref.pageName} ·{" "}
                  {ref.format === "unknown" ? "Format unavailable" : ref.format}
                </summary>
                <p className="mt-2 whitespace-pre-wrap">
                  {ref.bodies.join("\n") || ref.notes || "Copy unavailable"}
                </p>
                {ref.notes && ref.bodies.length > 0 && <p>{ref.notes}</p>}
                <p className="mt-2 text-muted-foreground">
                  {ref.signals.join(" · ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  Observed {new Date(ref.observedAt).toLocaleDateString()} ·{" "}
                  {ref.source === "manual"
                    ? "User supplied"
                    : "Meta Ads Library"}
                </p>
                {ref.url && (
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Open reference
                  </a>
                )}
              </details>
            ))}
            {research.references.length > 30 && (
              <p className="text-xs text-muted-foreground">
                The first 30 references are shown and used for this brief.
              </p>
            )}
          </section>
        )}
        {enabled &&
          research &&
          ["succeeded", "partial"].includes(research.status) &&
          research.references.length > 0 && (
            <fieldset
              className="space-y-3"
              disabled={busy || pending(brief?.status)}
            >
              <legend className="mb-3 font-medium">
                2. Describe what your business can offer
              </legend>
              <Label htmlFor="creative-facts">
                Product, offer and verified benefits
              </Label>
              <Textarea
                id="creative-facts"
                value={facts}
                onChange={(e) => setFacts(e.target.value)}
                placeholder="Describe your product and the claims you can support."
              />
              <Label htmlFor="creative-audience">Target audience</Label>
              <Input
                id="creative-audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="creative-objective">Objective</Label>
                  <select
                    id="creative-objective"
                    className={selectClass}
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                  >
                    {[
                      "leads",
                      "sales",
                      "traffic",
                      "awareness",
                      "engagement",
                      "app_installs",
                    ].map((value) => (
                      <option key={value} value={value}>
                        {value.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="creative-language">Creative language</Label>
                  <Input
                    id="creative-language"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  />
                </div>
              </div>
              <Label htmlFor="creative-destination">
                Landing page (optional)
              </Label>
              <Input
                id="creative-destination"
                value={landingUrl}
                onChange={(e) => setLandingUrl(e.target.value)}
              />
              <Label htmlFor="creative-constraints">
                Brand and production constraints
              </Label>
              <Textarea
                id="creative-constraints"
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="Available assets, tone, exclusions, shoot limitations…"
              />
              <Button
                onClick={suggest}
                disabled={
                  facts.trim().length < 10 ||
                  !audience.trim() ||
                  !language.trim()
                }
              >
                Suggest ad creatives
              </Button>
            </fieldset>
          )}
        {pending(brief?.status) && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Spinner size="sm" label={null} />
            Preparing evidence-linked creative suggestions. You can return to
            this saved brief later.
          </p>
        )}
        {brief?.status === "failed" && <p role="alert">{brief.message}</p>}
        {brief?.status === "ready" && (
          <section className="space-y-4" aria-label="Creative suggestions">
            <div>
              <h3 className="font-medium">3. Review your creative concepts</h3>
              <p className="text-sm text-muted-foreground">
                These are test hypotheses. Competitor performance is unknown.
                Selecting a concept prepares a draft workflow.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {brief.concepts.map((concept) => (
                <article
                  key={concept.id}
                  className={`space-y-3 rounded-lg border p-4 ${brief.selected_concept_id === concept.id ? "border-primary bg-primary/5" : ""}`}
                >
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {concept.format} · {brief.input.language}
                  </p>
                  <h4 className="font-semibold">{concept.title}</h4>
                  <p className="text-sm">
                    <strong>Hook:</strong> {concept.hook}
                  </p>
                  <p className="text-sm">
                    <strong>Headline:</strong> {concept.headline}
                  </p>
                  <p className="text-sm">{concept.copyDirection}</p>
                  <p className="text-sm">
                    <strong>Visual direction:</strong> {concept.visualDirection}
                  </p>
                  {concept.scenes.length > 0 && (
                    <ol className="list-inside list-decimal text-sm">
                      {concept.scenes.map((scene, i) => (
                        <li key={i}>{scene}</li>
                      ))}
                    </ol>
                  )}
                  <p className="text-sm">
                    <strong>CTA:</strong> {concept.ctaText}
                  </p>
                  <p className="text-sm">
                    <strong>Why test this:</strong> {concept.rationale}
                  </p>
                  <p className="text-sm">
                    <strong>Change to test:</strong> {concept.testVariable}
                  </p>
                  <p className="text-sm">
                    <strong>Measure:</strong>{" "}
                    {creativeTestMetric(brief.input.objective)}
                  </p>
                  <p className="text-sm">
                    <strong>Assets needed:</strong>{" "}
                    {concept.requiredAssets.join(", ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {concept.uncertainty}
                  </p>
                  <details className="text-xs">
                    <summary className="cursor-pointer">
                      Supporting references
                    </summary>
                    {concept.evidenceIds.map((id) => {
                      const ref = brief.evidence.find((item) => item.id === id);
                      return (
                        <p className="mt-2" key={id}>
                          {ref?.pageName}: {ref?.bodies[0] || ref?.notes}
                          {ref?.url && (
                            <>
                              {" "}
                              <a
                                className="underline"
                                href={ref.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                View reference
                              </a>
                            </>
                          )}
                        </p>
                      );
                    })}
                  </details>
                  <Button
                    size="sm"
                    variant={
                      brief.selected_concept_id === concept.id
                        ? "secondary"
                        : "outline"
                    }
                    disabled={
                      busy ||
                      !enabled ||
                      brief.selected_concept_id === concept.id
                    }
                    onClick={() => choose(concept.id)}
                  >
                    {brief.selected_concept_id === concept.id
                      ? "Selected"
                      : "Choose concept"}
                  </Button>
                </article>
              ))}
            </div>
            {brief.selected_concept_id && enabled && (
              <Button disabled={busy} onClick={openDraftReview}>Review ad-generation inputs</Button>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
