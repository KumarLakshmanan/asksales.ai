"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  Globe,
  ImageIcon,
  Loader2,
  Palette,
  Sparkles,
} from "lucide-react";
import api, { ApiError, buildApiUrl } from "@/lib/api";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { type WorkspaceWebsiteAnalysis } from "@/lib/workspace-profile";
import { trackSetupEvent } from "@/lib/setup-analytics";
import { SetupField, isOptionalWebUrl } from "./SetupFields";
import { WorkspaceSetupFrame } from "./WorkspaceSetupFrame";
import { KnowledgeBasePreview } from "./KnowledgeBasePreview";
import { Spinner } from "@/components/ui/spinner";

interface AnalysisJob {
  id: string;
  url?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  detail: string;
  updatedAt: string;
  result?: { data: Record<string, unknown>; kbEntryId?: number | null; analysisSummary?: WorkspaceWebsiteAnalysis["summary"] };
  error?: string;
  progress?: { crawled?: number; pages?: number };
}
const JOBS_ENDPOINT = "/api/setup/website-analysis/jobs";
const stageGroup = (stage?: string) => {
  if (!stage || ["queued", "retrying"].includes(stage)) return "queued";
  if (["fetching", "discovering", "selecting", "crawling"].includes(stage)) return "crawl";
  if (["extracting_colors", "extracting_fonts", "extracting_images", "extraction_complete", "analyzing", "screenshot_ready"].includes(stage)) return "extract";
  if (stage === "saving") return "knowledge";
  return stage;
};
const ANALYSIS_TABS = ["Overview", "Brand & images", "Knowledge base"];

export function WebsiteAnalyzer({
  profileId,
  website,
  analysis,
  ensureProfile,
  onWebsite,
  onAnalysis,
  onContinue,
  onCancel,
  showInvitations = false,
  hasSavedDetails = false,
}: {
  profileId?: number | null;
  website: string;
  analysis: WorkspaceWebsiteAnalysis | null;
  ensureProfile: (url: string) => Promise<number>;
  onWebsite: (url: string) => void;
  onAnalysis: (analysis: WorkspaceWebsiteAnalysis) => void;
  onContinue: () => void;
  onCancel: () => void;
  showInvitations?: boolean;
  hasSavedDetails?: boolean;
}) {
  const { subscribe } = useWebSocket();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [progress, setProgress] = useState("Reading your website");
  const [pages, setPages] = useState(0);
  const [tab, setTab] = useState("Overview");
  const tabsId = useId();
  const activeProfile = useRef<number | null>(null);
  const inFlight = useRef(false);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [proposed, setProposed] = useState<WorkspaceWebsiteAnalysis | null>(null);
  const processed = useRef<string | null>(null);
  const generation = useRef(0);
  const callbacks = useRef({ onAnalysis, analysis, website });
  useLayoutEffect(() => { callbacks.current = { onAnalysis, analysis, website }; }, [onAnalysis, analysis, website]);
  const reviewRefresh = useRef(false);
  const options = useCallback((id: number) => ({ headers: { [BUSINESS_PROFILE_HEADER]: String(id) } }), []);
  const handleUnavailable = useCallback((failure: unknown) => {
    if (!(failure instanceof ApiError) || typeof failure.status !== "number" || ![401, 403, 404].includes(failure.status)) return false;
    setRunning(false);
    setJob(null);
    setUnavailable(true);
    setError("This workspace or analysis is no longer available. Your saved details are preserved. Reload to check access.");
    return true;
  }, []);
  const receive = useCallback((value: AnalysisJob) => {
    setJob(value);
    setProgress(value.detail || "Preparing website analysis");
    if (typeof value.progress?.crawled === "number") setPages(value.progress.crawled);
    setRunning(value.status === "queued" || value.status === "running");
    if (value.status === "failed") {
      setError(value.error || "Analysis could not finish. Retry, or enter your details manually.");
      trackSetupEvent("analysis_failed", { stage: value.stage });
    }
    if (value.status === "completed" && value.result?.data && processed.current !== value.id) {
      processed.current = value.id;
      const saved: WorkspaceWebsiteAnalysis = {
        url: value.url || callbacks.current.website,
        analyzedAt: value.updatedAt,
        data: value.result.data,
        kbEntryId: value.result.kbEntryId || null,
        summary: value.result.analysisSummary || { pages: 0, knowledgeSaved: !!value.result.kbEntryId, warnings: [] },
      };
      setError("");
      setPages(saved.summary.pages);
      const current = callbacks.current.analysis;
      if (current && (reviewRefresh.current || (Date.parse(saved.analyzedAt) > Date.parse(current.analyzedAt) && JSON.stringify(saved.data) !== JSON.stringify(current.data)))) setProposed(saved);
      else if (!current) callbacks.current.onAnalysis(saved);
      setTab("Overview");
      trackSetupEvent("analysis_completed", { pages: saved.summary.pages, knowledgeSaved: saved.summary.knowledgeSaved });
    }
  }, []);

  useEffect(() => {
    if (!profileId || inFlight.current) return;
    const controller = new AbortController();
    activeProfile.current = profileId;
    setUnavailable(false);
    void api.get<{ job: AnalysisJob | null }>(`${JOBS_ENDPOINT}/latest`, { ...options(profileId), signal: controller.signal }).then((response) => {
      if (response.job && !controller.signal.aborted) receive(response.job);
    }).catch((failure) => {
      if (failure instanceof Error && failure.name === "AbortError") return;
      if (handleUnavailable(failure)) return;
      setError("Previous analysis status could not be checked. Retry analysis or continue with your saved details.");
    });
    return () => controller.abort();
  }, [profileId, options, receive, handleUnavailable]);

  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || !["queued", "running"].includes(jobStatus) || !activeProfile.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api.get<{ job: AnalysisJob }>(`${JOBS_ENDPOINT}/${jobId}`, { ...options(activeProfile.current!), signal: controller.signal });
        if (controller.signal.aborted) return;
        setError("");
        receive(response.job);
        if (["queued", "running"].includes(response.job.status)) timer = setTimeout(poll, 1500);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (handleUnavailable(failure)) return;
        setError("Analysis status is temporarily unavailable. Reconnecting…");
        timer = setTimeout(poll, 5000);
      }
    };
    timer = setTimeout(poll, 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId, jobStatus, options, receive, handleUnavailable]);

  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    if (!running) return;
    return subscribe("website_analysis_progress", (event) => {
      if (
        event.businessProfileId &&
        Number(event.businessProfileId) !== activeProfile.current
      )
        return;
      if (typeof event.detail === "string") setProgress(event.detail);
      if (typeof event.crawled === "number") setPages(event.crawled);
      if (event.crawlProgress && typeof event.crawlProgress === "object")
        setPages(
          Number((event.crawlProgress as { crawled?: number }).crawled) || 0,
        );
    });
  }, [running, subscribe]);
  const analyze = async () => {
    if (inFlight.current || running || unavailable) return;
    const normalized = /^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`;
    if (!website.trim() || !isOptionalWebUrl(normalized)) {
      setError("Enter a valid website address, such as https://example.com.");
      return;
    }
    const currentGeneration = generation.current;
    inFlight.current = true;
    setRunning(true);
    setError("");
    setProposed(null);
    setProgress("Preparing your workspace");
    setPages(0);
    reviewRefresh.current = !!analysis;
    trackSetupEvent("analysis_started", { reanalysis: !!analysis });
    try {
      onWebsite(normalized);
      const id = await ensureProfile(normalized);
      activeProfile.current = id;
      const result = await api.post<{ job: AnalysisJob }>(JOBS_ENDPOINT, { url: normalized, forceRefresh: true, idempotencyKey: crypto.randomUUID() }, options(id));
      if (currentGeneration !== generation.current) return;
      if (!result.job?.id) throw new Error("The analysis could not be started. Try again.");
      receive(result.job);
    } catch (failure) {
      if (currentGeneration !== generation.current) return;
      setRunning(false);
      setError(failure instanceof ApiError ? failure.message : "The connection was interrupted. Retry analysis, or enter your details manually.");
    } finally {
      inFlight.current = false;
    }
  };
  const cancelAnalysis = async () => {
    if (!job || !activeProfile.current) return;
    try {
      const response = await api.delete<{ job: AnalysisJob }>(`${JOBS_ENDPOINT}/${job.id}`, options(activeProfile.current));
      receive(response.job);
      setError("");
      trackSetupEvent("analysis_cancelled", { stage: job.stage });
    } catch { setError("Analysis could not be stopped. Check your connection and try again."); }
  };
  const details = analysis?.data || {};
  const images = Array.isArray(details.extractedImages)
    ? details.extractedImages.filter(
        (value): value is { url: string; originalUrl?: string } =>
          !!value && typeof value === "object" && typeof value.url === "string",
      )
    : [];
  const colors = Array.isArray(details.colorPalette)
    ? details.colorPalette.filter(
        (color): color is string =>
          typeof color === "string" && /^#[\da-f]{3,8}$/i.test(color),
      )
    : [];
  const fonts = Array.isArray(details.fontFamilies)
    ? details.fontFamilies
        .filter((value) => typeof value === "string")
        .join(", ")
    : "";
  const footer = (
    <>
      <button
        className="ws-button"
        type="button"
        onClick={onCancel}
        disabled={running}
      >
        <ArrowLeft size={16} />
        Cancel
      </button>
      <div className="ws-actions">
        {analysis && (
          <button
            className="ws-text-button"
            type="button"
            disabled={running}
            onClick={onContinue}
          >
            Continue with saved details
          </button>
        )}
        <button
          className={`ws-button ${analysis ? "ws-primary" : ""}`}
          type="button"
          onClick={onContinue}
        >
          {analysis
            ? "Review extracted details"
            : hasSavedDetails
              ? "Continue with saved details"
              : "Enter details manually"}
          <ArrowRight size={16} />
        </button>
      </div>
    </>
  );
  return (
    <WorkspaceSetupFrame footer={footer}>
      <section className="ws-analyzer" aria-label="Website analyzer">
        <div className="ws-analyzer-hero">
          <Globe size={29} aria-hidden="true" />
        </div>
        <div className="ws-eyebrow">
          <Sparkles size={14} />
          Website · Optional
        </div>
        <div className="ws-heading">
          <h1>
            {analysis ? "Your website results" : "Start with your website"}
          </h1>
          <p>
            {analysis
              ? "Review what we found, then make it yours in the next four steps."
              : "We'll find your details, brand colors, fonts, and images to get your workspace started."}
          </p>
        </div>
        {error && (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            {unavailable && <button type="button" className="ws-text-button mt-2" onClick={() => window.location.reload()}>Reload workspace status</button>}
          </div>
        )}
        <form
          className="ws-analyzer-input"
          onSubmit={(event) => {
            event.preventDefault();
            void analyze();
          }}
        >
          <SetupField
            label="Website URL"
            value={website}
            onChange={(value) => {
              if (!running) {
                onWebsite(value);
                if (!unavailable) setError("");
              }
            }}
            placeholder="https://yourwebsite.com"
          />
          <button
            type="submit"
            className="ws-button ws-primary"
            disabled={running || unavailable || !website.trim()}
          >
            {running ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Analyzing…
              </>
            ) : (
              <>
                <Sparkles size={16} />
                {error
                  ? "Retry analysis"
                  : analysis
                    ? "Analyze again"
                    : "Analyze website"}
              </>
            )}
          </button>
        </form>
        {running && (
          <div
            className="ws-analysis-progress"
            role="status"
            aria-live="polite"
          >
            <strong>
              <Spinner size="sm" label={null} />
              {progress}
            </strong>
            <p>
              {pages ? `${pages} pages read. ` : ""}This may take a few minutes.
              You can continue with your details while analysis runs. Return here to see its progress.
            </p>
            <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="Analysis stages">
              {["queued", "crawl", "extract", "knowledge", "complete"].map((stage, index) => <li key={stage} aria-current={stageGroup(job?.stage) === stage ? "step" : undefined} className={stageGroup(job?.stage) === stage ? "font-semibold text-primary" : "text-muted-foreground"}>{["Waiting", "Read pages", "Find brand details", "Save knowledge", "Ready"][index]}</li>)}
            </ol>
            {job && <button type="button" className="ws-text-button mt-3" onClick={() => void cancelAnalysis()}>Stop analysis</button>}
          </div>
        )}
        {proposed && <section className="my-5 space-y-3 rounded-xl border p-4" aria-label="Review refreshed website details">
          <h2 className="font-semibold">Review the refreshed details</h2>
          <p className="text-sm text-muted-foreground">Your current details are preserved. Apply these results to update the profile form, then review the changes before saving.</p>
          <dl className="space-y-2 text-sm">{["companyName", "description", "industry", "email", "phone"].filter(key => typeof proposed.data[key] === "string" && proposed.data[key] !== analysis?.data[key]).map(key => <div key={key}><dt className="font-medium">{{companyName:"Workspace name",description:"Description",industry:"Focus area",email:"Email",phone:"Phone"}[key]}</dt><dd className="break-words">{String(proposed.data[key])}</dd></div>)}</dl>
          <div className="flex flex-wrap gap-2"><button type="button" className="ws-button ws-primary" onClick={() => { onAnalysis(proposed); setProposed(null); }}>Apply refreshed details</button><button type="button" className="ws-button" onClick={() => setProposed(null)}>Keep current details</button></div>
        </section>}
        {!analysis && !running && (
          <div className="ws-analysis-features">
            <div>
              <Globe size={21} />
              <strong>Your details</strong>
              <p>Workspace name, description, and contact information.</p>
            </div>
            <div>
              <Palette size={21} />
              <strong>Your brand</strong>
              <p>Colors, typography, voice, and your logo.</p>
            </div>
            <div>
              <ImageIcon size={21} />
              <strong>Your images</strong>
              <p>Website photos and a screenshot for your brand toolkit.</p>
            </div>
          </div>
        )}
        {analysis && (
          <>
            <div className="ws-analysis-progress">
              <strong>
                <Check size={17} className="text-green-600" />
                Analysis saved to this workspace
              </strong>
              <p>
                <span>{analysis.summary.pages}</span> pages read ·{" "}
                {images.length} images found ·{" "}
                {analysis.summary.knowledgeSaved
                  ? "Website knowledge saved"
                  : "Knowledge not saved"}
              </p>
              <p>Source: <a className="underline" href={analysis.url} target="_blank" rel="noreferrer">{analysis.url}</a> · Analyzed {new Date(analysis.analyzedAt).toLocaleString()}</p>
              <p>Website details are suggestions. Review names, contact information, and brand choices before saving.</p>
              {Date.now() - Date.parse(analysis.analyzedAt) > 30 * 24 * 60 * 60 * 1000 && <p>These results are over 30 days old. Analyze again if your website has changed.</p>}
              {analysis.summary.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
            <div
              className="ws-analysis-tabs"
              role="tablist"
              aria-label="Website results"
            >
              {ANALYSIS_TABS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  role="tab"
                  id={`${tabsId}-tab-${index}`}
                  aria-selected={tab === label}
                  aria-controls={`${tabsId}-panel`}
                  tabIndex={tab === label ? 0 : -1}
                  onClick={() => setTab(label)}
                  onKeyDown={(event) => {
                    let next = index;
                    if (event.key === "ArrowRight")
                      next = (index + 1) % ANALYSIS_TABS.length;
                    else if (event.key === "ArrowLeft")
                      next =
                        (index + ANALYSIS_TABS.length - 1) %
                        ANALYSIS_TABS.length;
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End")
                      next = ANALYSIS_TABS.length - 1;
                    else return;
                    event.preventDefault();
                    setTab(ANALYSIS_TABS[next]);
                    event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      [next]?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="ws-results-panel"
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-tab-${ANALYSIS_TABS.indexOf(tab)}`}
              tabIndex={0}
            >
              {tab === "Overview" && (
                <dl>
                  {Object.entries({
                    "Workspace name": details.companyName || details.brandName,
                    "Focus area": details.industry,
                    Description: details.description,
                    "Contact email": details.email,
                    "Contact phone": details.phone,
                    Website: analysis.url,
                  }).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        {typeof value === "string" && value
                          ? value
                          : "Not found"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {tab === "Brand & images" && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-sm font-semibold">Colors and fonts</h2>
                    <div className="ws-extracted-colors">
                      {colors.map((color) => (
                        <span
                          key={color}
                          style={{ background: color }}
                          title={color}
                          aria-label={color}
                        />
                      ))}
                    </div>
                    <p className="ws-hint">
                      {fonts ||
                        "No fonts found. Choose your fonts in the brand toolkit."}
                    </p>
                  </div>
                  {typeof details.screenshotUrl === "string" && (
                    <div>
                      <h2 className="mb-3 text-sm font-semibold">
                        Website screenshot
                      </h2>
                      <img
                        src={buildApiUrl(details.screenshotUrl)}
                        alt="Your website screenshot"
                        className="max-h-80 w-full rounded-xl border object-contain"
                      />
                    </div>
                  )}
                  <div>
                    <h2 className="mb-3 text-sm font-semibold">
                      Website images
                    </h2>
                    {images.length ? (
                      <div className="ws-image-grid">
                        {images.map((asset, index) => (
                          <img
                            key={asset.url}
                            src={buildApiUrl(asset.url)}
                            alt={`Website image ${index + 1}`}
                            loading="lazy"
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="ws-hint">
                        No images found. You can add images in your brand
                        toolkit.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {tab === "Knowledge base" &&
                (analysis.kbEntryId ? (
                  <KnowledgeBasePreview entryId={analysis.kbEntryId} />
                ) : (
                  <div className="space-y-3">
                    <Database size={24} />
                    <p className="ws-hint">
                      Website knowledge could not be saved. Retry analysis to
                      save it, or continue with your extracted details.
                    </p>
                  </div>
                ))}
            </div>
          </>
        )}
        {showInvitations && (
          <p className="ws-hint mt-7">
            Joining an existing business?{" "}
            <Link href="/dashboard/invitations" className="underline">
              View your invitations
            </Link>
          </p>
        )}
      </section>
    </WorkspaceSetupFrame>
  );
}
