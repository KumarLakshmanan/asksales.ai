"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "@/components/marketing/marketing.module.css";
import { SocialAccountSetup } from "@/components/social-insights/SocialAccountSetup";
import { SocialReportsPanel } from "@/components/social-insights/SocialReportsPanel";
import { SocialListeningPanel } from "@/components/social-insights/SocialListeningPanel";
import {
  ContentFeed,
  ContentOverview,
  PublishingTrend,
  useSocialContent,
  type SocialContentData,
} from "@/components/social-insights/SocialContentInsights";
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Database,
  Eye,
  FileText,
  Gauge,
  MessageCircle,
  Plus,
  RefreshCw,
  Settings2,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";
import { socialInsightsGet } from "@/lib/socialInsightsApi";
import {
  validateAnalyticsWindow,
  isHttpsUrl,
  isIanaTimezone,
} from "@/lib/socialAnalyticsValidation";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EvidenceDisclosure,
  PerformanceEmptyState,
} from "@/components/performance-marketing/WorkspacePrimitives";
import { trackPerformanceMarketingEvent } from "@/lib/performanceMarketingAnalytics";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/timezoneDefaults";
import { useControlledDialogReturnFocus } from "@/hooks/use-controlled-dialog-return-focus";
import { compactMetric as compact } from "@/lib/display-format";
import { deviceTimeZone } from "../../../../../../../shared/timeZones";

type Platform = "facebook" | "instagram" | "youtube";
type SocialTab =
  | "content"
  | "overview"
  | "listening"
  | "competitors"
  | "reports";
type Metrics = Partial<
  Record<
    | "impressions"
    | "reach"
    | "engagements"
    | "views"
    | "likes"
    | "comments"
    | "shares"
    | "clicks"
    | "engagement_rate"
    | "followers"
    | "subscribers_gained"
    | "subscribers_lost",
    number
  >
>;
type Snapshot = {
  id: string;
  platform: Platform;
  account_identifier: string;
  metric_window_start: string;
  metric_window_end: string;
  metrics: Metrics;
  source: string;
  source_snapshot_id: string;
  timezone: string;
};
type Citation = {
  snapshotId: string;
  platform: string;
  accountIdentifier: string;
  windowStart: string;
  windowEnd: string;
  source: string;
  sourceSnapshotId: string;
  timezone: string;
};
type Recommendation = {
  recommendation: string | null;
  reason?: string;
  confidence?: number;
  citations: Citation[];
};
type BestTime = {
  id: string;
  platform: Platform;
  account_identifier: string;
  timezone: string;
  sample_size: number;
  confidence: string | number;
  fallback_used: boolean;
  methodology?: string;
  recommended_slots: Array<{
    dayOfWeek: number;
    hour: number;
    averageEngagement: number | null;
    observations?: number;
  }>;
};
type Dashboard = {
  sync?: {
    status: string;
    last_attempt_at: string | null;
    last_succeeded_at: string | null;
    next_due_at: string | null;
    error_code: string | null;
  } | null;
  summary: Metrics;
  trends: Array<{ date: string } & Metrics>;
  recommendation: Recommendation;
  bestTime: BestTime | null;
  previousPeriod: { start: string; end: string; summary: Metrics } | null;
  freshness: {
    truncated?: boolean;
    latestSnapshotAt: string | null;
    snapshotCount: number;
    evidenceSourceCount: number;
  };
};
type Competitor = {
  id: string;
  platform: Platform;
  public_handle: string;
  display_name?: string | null;
  public_url: string;
  is_active: boolean;
  last_refresh_status?: string;
  last_refresh_error?: string;
  last_refresh_attempt_at?: string;
  latest_public_snapshot?: {
    metrics: Metrics;
    capturedAt: string;
    source: string;
    sourceUrl: string;
  } | null;
};
type CompetitorBenchmark = {
  benchmark: null | {
    competitor: { id: string; platform: Platform; handle: string };
    workspaceSnapshotId: string;
    workspaceSnapshotIds?: string[];
    competitorSnapshotId: string;
    metrics: Array<{
      metric: string;
      workspace: number;
      competitor: number;
      delta: number;
      percentDelta: number | null;
    }>;
    comparability: string;
  };
  reason?: string;
  citations: Array<Record<string, unknown>>;
};
type Account = {
  id: number;
  accountIdentifier: string | null;
  accountName: string | null;
  displayName: string | null;
  profilePictureUrl: string | null;
  isSelected: boolean;
  usesInstagramLogin: boolean;
  analyticsReady: boolean;
  analyticsReadinessCode: string | null;
  analyticsReadinessMessage: string | null;
};

const platformCredential: Record<Platform, string> = {
  facebook: "facebook_api",
  instagram: "instagram_api",
  youtube: "youtube",
};
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const tabs = new Set<SocialTab>([
  "content",
  "overview",
  "listening",
  "competitors",
  "reports",
]);
const isoDay = (daysFromToday: number) =>
  new Date(Date.now() - daysFromToday * 86_400_000).toISOString().slice(0, 10);
const displayWindow = (start: string, end: string) =>
  `${new Date(start).toLocaleDateString()}–${new Date(end).toLocaleDateString()}`;
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";
const browserTimezone = () => {
  const value =
    deviceTimeZone(DEFAULT_BUSINESS_TIMEZONE);
  return isIanaTimezone(value) ? value : DEFAULT_BUSINESS_TIMEZONE;
};

export default function SocialInsightsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab") as SocialTab | null;
  const urlTab: SocialTab =
    requestedTab && tabs.has(requestedTab) ? requestedTab : "overview";
  const [activeTab, setActiveTab] = useState<SocialTab>(urlTab);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [benchmarks, setBenchmarks] = useState<
    Record<string, CompetitorBenchmark>
  >({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [channelAccounts, setChannelAccounts] = useState<
    Partial<Record<Platform, Account[]>>
  >({});
  const [channelErrors, setChannelErrors] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const dashboardRequest = useRef(0);
  const supportingRequest = useRef(0);
  const [platform, setPlatform] = useState<Platform>(
    ["facebook", "instagram", "youtube"].includes(
      searchParams.get("platform") || "",
    )
      ? (searchParams.get("platform") as Platform)
      : "instagram",
  );
  const [credentialId, setCredentialId] = useState(
    searchParams.get("account") || "",
  );
  const credentialIdRef = useRef(credentialId);
  credentialIdRef.current = credentialId;
  const [startDate, setStartDate] = useState(
    searchParams.get("start") || isoDay(30),
  );
  const [endDate, setEndDate] = useState(searchParams.get("end") || isoDay(1));
  const [timezone, setTimezone] = useState(DEFAULT_BUSINESS_TIMEZONE);
  const [loading, setLoading] = useState(true);
  const [working, setBusy] = useState(false);
  const [syncJob, setSyncJob] = useState<string | null>(null);
  const busy = working || Boolean(syncJob);
  const [contentRevision, setContentRevision] = useState(0);
  const [contentDay, setContentDay] = useState<string | null>(null);
  const [showAllCapturedPosts, setShowAllCapturedPosts] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [supportingError, setSupportingError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const connectionsOpener = useRef<HTMLButtonElement | null>(null);
  const connectionsReturnFocus = useControlledDialogReturnFocus(connectionsOpen, connectionsOpener);
  const openConnections = (opener: HTMLButtonElement | null) => {
    connectionsOpener.current = opener;
    setConnectionsOpen(true);
  };
  const [competitorOpen, setCompetitorOpen] = useState(false);
  const [editingCompetitor, setEditingCompetitor] = useState<Competitor | null>(
    null,
  );
  const [deletingCompetitor, setDeletingCompetitor] =
    useState<Competitor | null>(null);
  const [evidenceCompetitor, setEvidenceCompetitor] =
    useState<Competitor | null>(null);
  const [competitorHandle, setCompetitorHandle] = useState("");
  const [competitorUrl, setCompetitorUrl] = useState("");
  const [competitorSnapshotUrl, setCompetitorSnapshotUrl] = useState("");
  const [competitorMetrics, setCompetitorMetrics] = useState<
    Record<string, string>
  >({
    impressions: "",
    reach: "",
    engagements: "",
    views: "",
    likes: "",
    comments: "",
    shares: "",
    clicks: "",
  });

  useEffect(() => {
    setTimezone(browserTimezone());
  }, []);
  useEffect(() => {
    setActiveTab(urlTab);
  }, [urlTab]);

  const updateQuery = useCallback((updates: Record<string, string>) => {
    const next = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([key, value]) =>
      value ? next.set(key, value) : next.delete(key),
    );
    // Next observes native history updates. One synchronous update prevents
    // account selection from replacing a just-selected platform with old URL state.
    window.history.replaceState(
      window.history.state,
      "",
      `/dashboard/marketing/analytics?${next.toString()}`,
    );
  }, []);

  useEffect(() => {
    const nextPlatform = searchParams.get("platform");
    if (
      nextPlatform &&
      ["facebook", "instagram", "youtube"].includes(nextPlatform)
    )
      setPlatform(nextPlatform as Platform);
    setCredentialId(searchParams.get("account") || "");
    setStartDate(searchParams.get("start") || isoDay(30));
    setEndDate(searchParams.get("end") || isoDay(1));
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    setAccountsLoading(true);
    setError(null);
    void socialInsightsGet<Account[]>(
      `/api/channel-accounts/${platformCredential[platform]}`,
    )
      .then((next) => {
        if (cancelled) return;
        setAccounts(next);
        const requestedId = credentialIdRef.current;
        const requested = next.find(
          (account) => String(account.id) === requestedId,
        );
        const selected =
          requested || next.find((account) => account.isSelected) || next[0];
        const nextId = selected ? String(selected.id) : "";
        setCredentialId(nextId);
        if (nextId && nextId !== requestedId)
          updateQuery({ platform, account: nextId });
      })
      .catch(() => {
        if (cancelled) return;
        setAccounts([]);
        setCredentialId("");
        setError(
          `Connected ${platform} accounts could not be loaded. Reconnect the channel and try again.`,
        );
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Picking an account must not reload the account list; only a platform change does.
  }, [platform, updateQuery]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled(
      (Object.keys(platformCredential) as Platform[]).map(async (channel) => ({
        channel,
        accounts: await socialInsightsGet<Account[]>(
          `/api/channel-accounts/${platformCredential[channel]}`,
        ),
      })),
    ).then((results) => {
      if (cancelled) return;
      const next: Partial<Record<Platform, Account[]>> = {};
      const errors: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled")
          next[result.value.channel] = result.value.accounts;
        else errors.push(Object.keys(platformCredential)[index]);
      });
      setChannelAccounts(next);
      setChannelErrors(errors);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAccount = useMemo(
    () => accounts.find((account) => String(account.id) === credentialId),
    [accounts, credentialId],
  );
  const selectedAccountIdentifier = selectedAccount?.accountIdentifier;
  const windowError = validateAnalyticsWindow(startDate, endDate, timezone);
  const analyticsUnavailable = selectedAccount?.analyticsReady === false;
  const content = useSocialContent(
    credentialId,
    platform,
    startDate,
    endDate,
    !accountsLoading && !windowError,
    contentRevision,
  );
  const showFullPostHistory = showAllCapturedPosts && !contentDay;
  const feedStartDate = showFullPostHistory ? "1970-01-01" : startDate;
  const feedEndDate = showFullPostHistory ? isoDay(0) : endDate;
  const feedContent = useSocialContent(
    credentialId,
    platform,
    feedStartDate,
    feedEndDate,
    activeTab === "content" && !accountsLoading && Boolean(selectedAccount),
    contentRevision,
  );
  const connectedChannels = useMemo(
    () => (Object.keys(platformCredential) as Platform[]).filter(
      (channel) => (channelAccounts[channel]?.length ?? 0) > 0,
    ),
    [channelAccounts],
  );
  useEffect(() => {
    if (accountsLoading || selectedAccount || accounts.length) return;
    const channel = connectedChannels[0];
    const account = channel && channelAccounts[channel]?.[0];
    if (!channel || !account) return;
    setPlatform(channel);
    setCredentialId(String(account.id));
    updateQuery({ platform: channel, account: String(account.id) });
  }, [accounts.length, accountsLoading, channelAccounts, connectedChannels, selectedAccount, updateQuery]);
  const integrationRoute = `/dashboard/integrations/${platform}`;
  const reconnectForAnalytics = async () => {
    if (platform !== 'instagram' || !selectedAccount?.usesInstagramLogin) {
      router.push(integrationRoute);
      return;
    }
    try {
      const result = await api.get<{ url: string }>(
        '/api/instagram/oauth/authorize?format=json&feature=instagram_manage_insights',
      );
      if (!result.url) throw new Error('Instagram sign-in could not be started.');
      window.location.assign(result.url);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const filterQuery = useMemo(() => {
    const values = new URLSearchParams({
      platform,
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T23:59:59.999Z`,
    });
    if (selectedAccountIdentifier)
      values.set("accountIdentifier", selectedAccountIdentifier);
    return values.toString();
  }, [endDate, platform, selectedAccountIdentifier, startDate]);

  const loadDashboard = useCallback(
    async (background = false) => {
      const request = ++dashboardRequest.current;
      if (accountsLoading) return;
      if (windowError) {
        setError(windowError);
        setLoading(false);
        return;
      }
      if (!selectedAccountIdentifier) {
        setDashboard(null);
        setLoading(false);
        return;
      }
      try {
        if (!background) setLoading(true);
        const result = await socialInsightsGet<Dashboard>(
          `/api/social-analytics/dashboard?${filterQuery}`,
        );
        if (request === dashboardRequest.current) {
          setDashboard(result);
          setDashboardError(null);
        }
      } catch (cause) {
        if (request === dashboardRequest.current)
          setDashboardError(errorText(cause));
      } finally {
        if (request === dashboardRequest.current) setLoading(false);
      }
    },
    [accountsLoading, filterQuery, selectedAccountIdentifier, windowError],
  );

  const loadSupporting = useCallback(async () => {
    const request = ++supportingRequest.current;
    if (windowError) return;
    const benchmarkQuery = new URLSearchParams({
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T23:59:59.999Z`,
    });
    if (selectedAccountIdentifier)
      benchmarkQuery.set("accountIdentifier", selectedAccountIdentifier);
    const competitorsResult = await Promise.allSettled([
      socialInsightsGet<Competitor[]>(
        `/api/social-analytics/competitors?platform=${platform}&includeArchived=1`,
      ),
    ]).then((results) => results[0]);
    if (request !== supportingRequest.current) return;
    const failures: string[] = [];
    const nextCompetitors =
      competitorsResult.status === "fulfilled" ? competitorsResult.value : [];
    if (competitorsResult.status === "fulfilled")
      setCompetitors(nextCompetitors);
    else failures.push("Competitors could not be loaded.");
    const benchmarkResults = await Promise.allSettled(
      nextCompetitors.map(
        async (competitor) =>
          [
            competitor.id,
            await socialInsightsGet<CompetitorBenchmark>(
              `/api/social-analytics/competitors/${competitor.id}/benchmark?${benchmarkQuery.toString()}`,
            ),
          ] as const,
      ),
    );
    if (request !== supportingRequest.current) return;
    const nextBenchmarks: Record<string, CompetitorBenchmark> = {};
    benchmarkResults.forEach((result, index) => {
      if (result.status === "fulfilled")
        nextBenchmarks[result.value[0]] = result.value[1];
      else {
        const competitor = nextCompetitors[index];
        if (competitor)
          nextBenchmarks[competitor.id] = {
            benchmark: null,
            reason:
              "This benchmark could not be loaded. Retry to restore its cited comparison.",
            citations: [],
          };
      }
    });
    setBenchmarks(nextBenchmarks);
    setSupportingError(failures.length ? failures.join(" ") : null);
  }, [endDate, platform, selectedAccountIdentifier, startDate, windowError]);

  useEffect(() => {
    setDashboard(null);
    setSnapshots([]);
  }, [filterQuery]);
  useEffect(() => {
    void loadDashboard();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadDashboard(true);
    }, 60_000);
    return () => {
      window.clearInterval(interval);
      dashboardRequest.current++;
    };
  }, [loadDashboard]);
  useEffect(() => {
    let current = true;
    if (activeTab !== "competitors") return;
    void loadSupporting().catch((cause) => {
      if (current) setSupportingError(errorText(cause));
    });
    return () => {
      current = false;
    };
  }, [loadSupporting, activeTab, contentRevision]);
  useEffect(() => {
    if (!connectionsOpen || !selectedAccountIdentifier) return;
    let current = true;
    void socialInsightsGet<Snapshot[]>(
      `/api/social-analytics/snapshots?${filterQuery}`,
    )
      .then((value) => {
        if (current) setSnapshots(value);
      })
      .catch((cause) => {
        if (current) setError(errorText(cause));
      });
    return () => {
      current = false;
    };
  }, [connectionsOpen, filterQuery, selectedAccountIdentifier]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const chooseAccount = useCallback(
    (channel: Platform, id: string) => {
      const nextAccounts = (channelAccounts[channel] || []).map((account) => ({
        ...account,
        isSelected: String(account.id) === id,
      }));
      setPlatform(channel);
      setCredentialId(id);
      setAccounts(nextAccounts);
      setDashboard(null);
      setChannelAccounts((current) => ({
        ...current,
        [channel]: nextAccounts,
      }));
      updateQuery({ platform: channel, account: id });
      trackPerformanceMarketingEvent("filter_changed", {
        workspace: "social_insights",
        filter: "account",
        value: channel,
      });
      void api
        .post(`/api/channel-accounts/${platformCredential[channel]}/select`, {
          credentialId: Number(id),
        })
        .catch((cause) =>
          setError(
            `The account view changed, but the default account could not be saved. ${errorText(cause)}`,
          ),
        );
    },
    [channelAccounts, updateQuery],
  );

  const syncOfficialData = async (opener: HTMLButtonElement | null) => {
    if (windowError) {
      setError(windowError);
      return;
    }
    if (!credentialId) {
      openConnections(opener);
      return;
    }
    if (analyticsUnavailable) {
      setError(
        selectedAccount?.analyticsReadinessMessage ||
          `Reconnect ${platform} with analytics access before synchronizing Social Insights.`,
      );
      return;
    }
    await run(async () => {
      const result = await api.post<{
        queued?: boolean;
        jobId?: string;
        inserted: number;
        duplicates: number;
        limitations?: string[];
      }>("/api/social-analytics/sync", {
        platform,
        credentialId: Number(credentialId),
        startDate,
        endDate,
        timezone,
      });
      if (result.queued && result.jobId) {
        setSyncJob(result.jobId);
        setNotice(
          "Sync queued. Account metrics and published content will refresh here when it finishes.",
        );
        return;
      }
      setContentRevision((value) => value + 1);
      setNotice(
        result.limitations?.length
          ? `Synced ${result.inserted} measurements. ${result.limitations.join(" ")}`
          : result.inserted > 0
            ? `Synced ${result.inserted} new measurement${result.inserted === 1 ? "" : "s"}.`
            : result.duplicates > 0
              ? "Social measurements are already up to date."
              : result.limitations?.[0] ||
                "Meta returned no measurements for this date range.",
      );
      await Promise.all([
        loadDashboard(),
        loadSupporting(),
        ...(connectionsOpen
          ? [
              socialInsightsGet<Snapshot[]>(
                `/api/social-analytics/snapshots?${filterQuery}`,
              ).then(setSnapshots),
            ]
          : []),
      ]);
    });
  };

  useEffect(() => {
    setSyncJob(null);
    setContentDay(null);
    setNotice(null);
    setError(null);
    setDashboardError(null);
    setSupportingError(null);
    setCompetitors([]);
    setBenchmarks({});
  }, [credentialId, platform]);
  useEffect(() => {
    if (!syncJob) return;
    let cancelled = false;
    let polling = false;
    let failures = 0;
    const check = async () => {
      if (polling) return;
      polling = true;
      try {
        const job = await socialInsightsGet<{
          state: string;
          error?: string;
          result?: {
            status: number;
            body: {
              error?: string;
              inserted?: number;
              content?: { count: number; complete: boolean };
              partialSuccess?: boolean;
            };
          };
        }>(`/api/social-analytics/sync-jobs/${encodeURIComponent(syncJob)}`);
        if (cancelled) return;
        failures = 0;
        if (job.state === "completed" || job.state === "failed") {
          setSyncJob(null);
          setContentRevision((value) => value + 1);
          const result = job.result;
          if (job.state === "failed" || (result && result.status >= 400)) {
            setError(
              job.error ||
                result?.body.error ||
                "The sync could not finish. Saved data is still available.",
            );
            setNotice(null);
          } else
            setNotice(
              `Sync finished. ${result?.body.content ? `${result.body.content.count} published items refreshed. ` : ""}${result?.body.partialSuccess ? "Some provider data is unavailable; check data availability for details." : "Account metrics are up to date."}`,
            );
          await Promise.allSettled([loadDashboard(), loadSupporting()]);
        } else {
          setNotice(
            "Sync in progress. You can keep browsing saved posts and metrics.",
          );
        }
      } catch {
        if (!cancelled && ++failures >= 10) {
          setSyncJob(null);
          setError(
            "Sync status is temporarily unavailable. The server may still be syncing; reload this page shortly to check the results.",
          );
          setNotice(null);
        }
      } finally {
        polling = false;
      }
    };
    void check();
    // A hidden tab skips its checks and catches up as soon as it is shown again.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void check();
    }, 3000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [syncJob, loadDashboard, loadSupporting]);

  const summary = dashboard?.summary || {};
  const hasDailyPerformance = [
    "reach",
    "views",
    "impressions",
    "engagements",
  ].some((key) => summary[key as keyof Metrics] != null);
  const emptyAfterSync =
    dashboard?.sync?.status === "succeeded" &&
    Boolean(dashboard.sync.last_succeeded_at) &&
    !dashboard.freshness.snapshotCount;
  const latestLabel = dashboard?.freshness.latestSnapshotAt
    ? `Data through: ${new Date(dashboard.freshness.latestSnapshotAt).toLocaleString()}`
    : emptyAfterSync
      ? `Last successful sync: ${new Date(dashboard!.sync!.last_succeeded_at!).toLocaleString()}`
      : "No data synced";
  const latestAge = dashboard?.sync?.last_succeeded_at
    ? Date.now() - new Date(dashboard.sync.last_succeeded_at).getTime()
    : Number.POSITIVE_INFINITY;
  const isStale = Number.isFinite(latestAge) && latestAge > 48 * 60 * 60 * 1000;
  const isPartial =
    dashboard?.sync?.status === "failed" &&
    Boolean(dashboard?.freshness.snapshotCount);
  const freshnessState = emptyAfterSync
    ? "fresh"
    : !dashboard?.freshness.latestSnapshotAt
      ? "disconnected"
      : isStale
        ? "stale"
        : isPartial
          ? "partial"
          : "fresh";

  return (
    <PageShell maxWidth="2xl" padding="md" className={`${styles.surface} mx-0`}>
      <PageHeader
        className={styles.header}
        icon={Gauge}
        title="Social Insights"
        subtitle="Understand organic performance across Facebook, Instagram, and YouTube."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={(event) => {
                trackPerformanceMarketingEvent("data_connections_opened", {
                  workspace: "social_insights",
                });
                openConnections(event.currentTarget);
              }}
            >
              <Settings2 className="mr-2 h-4 w-4" />
              Data &amp; connections
            </Button>
          </div>
        }
      />
      {(error || dashboardError || supportingError) && (
        <div
          role="alert"
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <div>
            <p className="font-medium">Social Insights needs attention</p>
            <p className="mt-0.5">
              {error || dashboardError || supportingError}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              analyticsUnavailable
                ? void reconnectForAnalytics()
                : void Promise.allSettled([loadDashboard(), loadSupporting()])
            }
          >
            {analyticsUnavailable ? `Reconnect ${platform}` : "Try again"}
          </Button>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </div>
      )}
      <Tabs
            value={activeTab}
            className={styles.workspace}
            onValueChange={(value) => {
              const next = value as SocialTab;
              setActiveTab(next);
              trackPerformanceMarketingEvent("workspace_tab_changed", {
                workspace: "social_insights",
                tab: next,
              });
              updateQuery({ tab: next });
            }}
          >
      <div className={styles.socialNav}><label className="block text-sm font-medium md:hidden">
              View
              <select
                aria-label="Social Insights section"
                className="mt-2 w-full rounded-md border bg-background p-3"
                value={activeTab}
                onChange={(event) => {
                  const tab = event.target.value as SocialTab;
                  setActiveTab(tab);
                  updateQuery({ tab });
                }}
              >
                <option value="overview">Overview</option>
                {content.supported && (
                  <option value="content">Posts &amp; comments</option>
                )}
                <option value="listening">Listening</option>
                <option value="competitors">Competitors</option>
                <option value="reports">Reports</option>
              </select>
            </label>
            <div className="hidden overflow-x-auto pb-1 md:block">
              <TabsList className={styles.tabs}>
                <TabsTrigger value="overview" className="gap-2 px-4">
                  <BarChart3 className="h-4 w-4" />
                  Overview
                </TabsTrigger>
                {(content.supported || !selectedAccount) && (
                  <TabsTrigger value="content" disabled={!selectedAccount} className="gap-2 px-4">
                    <MessageCircle className="h-4 w-4" />
                    Posts &amp; comments
                  </TabsTrigger>
                )}
                <TabsTrigger value="listening" disabled={!selectedAccount} className="gap-2 px-4">
                  <MessageCircle className="h-4 w-4" />
                  Listening
                </TabsTrigger>
                <TabsTrigger value="competitors" disabled={!selectedAccount} className="gap-2 px-4">
                  <Users className="h-4 w-4" />
                  Competitors
                </TabsTrigger>
                <TabsTrigger value="reports" disabled={!selectedAccount} className="gap-2 px-4">
                  <FileText className="h-4 w-4" />
                  Reports
                </TabsTrigger>
              </TabsList>
            </div></div>
      <div className={(!selectedAccount || activeTab === "overview") ? "grid items-start gap-3" : "grid items-start gap-4 lg:grid-cols-[180px_minmax(0,1fr)]"}>
        <aside
          aria-label="Connected social accounts"
          className={`${styles.accountRail} hidden space-y-4 ${(!selectedAccount || activeTab === "overview") ? "lg:hidden" : "lg:block"}`}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-muted-foreground">
              Your channels
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose an account to explore its audience and content.
            </p>
          </div>
          {(["facebook", ...connectedChannels.filter((channel) => channel !== "facebook")] as Platform[]).map((channel) => (
            <div key={channel}>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold capitalize">{channel}</h2>
                <span className="text-xs text-muted-foreground">
                  {channelAccounts[channel]?.length ?? "—"}
                </span>
              </div>
              <div className="space-y-1">
                {channel === "facebook" && !channelAccounts.facebook?.length && !channelErrors.includes("facebook") && (
                  <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => router.push("/dashboard/integrations/facebook")}>
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    Connect Facebook Page
                  </Button>
                )}
                {channelAccounts[channel]?.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    aria-current={
                      platform === channel &&
                      credentialId === String(account.id)
                        ? "page"
                        : undefined
                    }
                    onClick={() => chooseAccount(channel, String(account.id))}
                    className={`flex w-full items-center gap-3 rounded-md border-l-2 px-3 py-3 text-left transition-colors ${platform === channel && credentialId === String(account.id) ? "border-primary bg-primary/5 text-foreground" : "border-transparent text-muted-foreground hover:bg-muted"}`}
                  >
                    <Avatar className="h-8 w-8 text-xs font-semibold">
                      {account.profilePictureUrl && (
                        <AvatarImage src={account.profilePictureUrl} alt="" />
                      )}
                      <AvatarFallback>
                        {(account.displayName || account.accountName || channel)
                          .slice(0, 2)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {account.displayName || account.accountName || account.accountIdentifier}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {channel === "instagram" && account.displayName && account.displayName !== account.accountName
                          ? `@${(account.accountName || "").replace(/^@/, "")} · ${account.analyticsReady ? "Connected" : "Check analytics access"}`
                          : account.analyticsReady
                            ? "Connected"
                            : "Check analytics access"}
                      </span>
                    </span>
                  </button>
                ))}
                {channelErrors.includes(channel) && (
                  <p className="text-xs text-destructive">
                    Account list unavailable
                  </p>
                )}
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => router.push("/dashboard/integrations")}
          >
            <Plus className="mr-2 h-3 w-3" />
            {connectedChannels.length ? "Manage accounts" : "Integrate accounts"}
          </Button>
        </aside>
        <section
          className={`${styles.workspace} min-w-0`}
          aria-label="Selected account insights"
        >
          {accountsLoading ? (
            <OverviewSkeleton />
          ) : !selectedAccount ? (
            <SocialAccountSetup onConnect={() => router.push("/dashboard/integrations")} />
          ) : (
          <>

          <h2 className="sr-only">{selectedAccount.displayName || selectedAccount.accountName || selectedAccount.accountIdentifier} · {platform} organic performance</h2>
          <div
            aria-label="Social Insights filters"
            className={`${styles.filters} flex flex-wrap items-end gap-3`}
          >
            <label className={`block text-xs font-medium text-muted-foreground ${activeTab === "overview" ? "" : "lg:hidden"}`}>
            Connected account
            <select
              aria-label="Connected account"
              value={`${platform}:${credentialId}`}
              onChange={(event) => {
                const [channel, id] = event.target.value.split(":");
                chooseAccount(channel as Platform, id);
              }}
              className="mt-1 block h-9 w-full min-w-48 rounded-md border bg-background px-3 text-sm text-foreground"
            >
              {connectedChannels.map(
                (channel) => (
                  <optgroup key={channel} label={channel}>
                    {channelAccounts[channel]?.map((account) => (
                      <option
                        key={account.id}
                        value={`${channel}:${account.id}`}
                      >
                        {account.displayName || account.accountName || account.accountIdentifier}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </label>
            <label className="text-xs text-muted-foreground">
              Period
              <select
                aria-label="Social date preset"
                className="mt-1 block h-10 w-[170px] rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={
                  endDate === isoDay(1)
                    ? [7, 30, 90, 180, 365]
                        .find((value) => startDate === isoDay(value))
                        ?.toString() || "custom"
                    : "custom"
                }
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "custom") return;
                  const start = isoDay(Number(value));
                  const end = isoDay(1);
                  setStartDate(start);
                  setEndDate(end);
                  updateQuery({ start, end });
                }}
              >
                <option value="custom">Custom dates</option>
                {[7, 30, 90, 180, 365].map((value) => (
                  <option key={value} value={String(value)}>
                    Last {value} days
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Start date (UTC)
              <Input
                className="mt-1 w-[155px]"
                aria-label="Start date"
                type="date"
                max={endDate}
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  updateQuery({ start: event.target.value });
                }}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              End date (UTC)
              <Input
                className="mt-1 w-[155px]"
                aria-label="End date"
                type="date"
                min={startDate}
                max={isoDay(0)}
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  updateQuery({ end: event.target.value });
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                busy ||
                accountsLoading ||
                Boolean(windowError) ||
                !credentialId ||
                analyticsUnavailable
              }
              onClick={(event) => void syncOfficialData(event.currentTarget)}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 motion-reduce:animate-none ${busy ? "animate-spin" : ""}`}
              />
              {busy ? "Syncing…" : "Sync now"}
            </Button>
          </div>
          {windowError && (
            <p role="alert" className="text-sm text-destructive">
              {windowError}
            </p>
          )}

          {dashboard?.freshness.truncated && <p role="status" className="rounded-lg border border-amber-500/30 p-3 text-sm">This report reached the 10,000 snapshot limit. Totals are incomplete; narrow the reporting dates or account. Saved exports include the same limit warning.</p>}

          <AccountFreshness
            state={analyticsUnavailable ? "error" : freshnessState}
            title={
              analyticsUnavailable
                ? "Analytics permission required"
                : emptyAfterSync
                  ? content.data?.totalPosts
                    ? "Connected — published content available"
                    : "Connected — no measurements in this range"
                  : !dashboard?.freshness.latestSnapshotAt
                    ? credentialId
                      ? "Connected — first sync needed"
                      : "Connect and sync an account"
                    : isStale
                      ? "Social data is stale"
                      : isPartial
                        ? "Connected with partial metrics"
                        : "Connected data available"
            }
            detail={`${analyticsUnavailable ? "No provider analytics access" : latestLabel}`}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) =>
                  analyticsUnavailable
                    ? void reconnectForAnalytics()
                    : dashboard?.freshness.latestSnapshotAt
                      ? openConnections(event.currentTarget)
                      : credentialId
                        ? void syncOfficialData(event.currentTarget)
                        : openConnections(event.currentTarget)
                }
              >
                {analyticsUnavailable
                  ? "Reconnect"
                  : dashboard?.freshness.latestSnapshotAt
                    ? "Manage data"
                    : credentialId
                      ? "Sync now"
                      : "Connect"}
              </Button>
            }
          />

            <TabsContent value="overview" className="mt-5 space-y-5">
              {loading || accountsLoading ? (
                <OverviewSkeleton />
              ) : !hasDailyPerformance && Boolean(content.data?.totalPosts) ? (
                <Card>
                  <CardContent className="py-4 text-sm text-muted-foreground">
                    Meta returned no daily Page metrics for this range. The
                    content totals below are cumulative measurements for posts
                    published in this window; they are not daily Page totals.
                  </CardContent>
                </Card>
              ) : emptyAfterSync ? (
                <Card>
                  <EmptyBlock
                    icon={BarChart3}
                    title="No measurements in this date range"
                    text="The account synchronized successfully, but Meta returned no measurements for this view. Try a different date range or check again after new activity."
                  />
                </Card>
              ) : !dashboard?.freshness.snapshotCount ? (
                <EmptySocialState
                  connected={Boolean(credentialId)}
                  analyticsReady={!analyticsUnavailable}
                  onAction={(opener) =>
                    analyticsUnavailable
                      ? void reconnectForAnalytics()
                      : credentialId
                        ? void syncOfficialData(opener)
                        : openConnections(opener)
                  }
                />
              ) : (
                <>
                  <div className={styles.socialMetrics}>
                    <Metric label="Daily reach sum" value={compact(summary.reach)}/>
                    <Metric label="Engagements" value={compact(summary.engagements)}/>
                    <Metric label="Views" value={compact(summary.views)}/>
                    <Metric label="Follower movement" value={socialFollowerMovement(dashboard.trends)}/>
                    <Metric label="Engagement rate" value={Number(summary.reach || summary.impressions || 0) > 0 ? `${Number(summary.engagement_rate || 0).toFixed(1)}%` : "—"}/>
                  </div>
                  <PublishingTrend
                    trends={dashboard.trends}
                    timeline={content.data?.timeline || []}
                    startDate={startDate}
                    endDate={endDate}
                  />
                  <div className={styles.twoCharts}><BestTimeCard value={dashboard.bestTime}/><GrowthReporting compactView
                    trends={dashboard.trends}
                    previousPeriod={dashboard.previousPeriod}
                    content={content.data}
                    startDate={startDate}
                    endDate={endDate}
                  /></div>
                  <details className="rounded-xl border bg-card px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Publishing guidance &amp; supporting evidence
                    </summary>
                    <div className="mt-4 grid gap-6 md:grid-cols-2">
                      <dl className="grid grid-cols-2 gap-3 text-xs"><div><dt>Clicks</dt><dd className="mt-1 font-medium">{summary.clicks == null ? "Unavailable" : compact(summary.clicks)}</dd></div><div><dt>Impressions</dt><dd className="mt-1 font-medium">{summary.impressions == null ? "Unavailable" : compact(summary.impressions)}</dd></div></dl>
                      <div className="space-y-3 text-sm">
                        <p>
                          {(
                            dashboard.recommendation.recommendation ||
                            dashboard.recommendation.reason ||
                            "More measurements are needed before recommending a publishing change."
                          ).replace(
                            `${platform}/${selectedAccountIdentifier}`,
                            selectedAccount?.accountName || platform,
                          )}
                        </p>
                        <EvidenceDisclosure>
                          <div className="space-y-2">
                            {dashboard.recommendation.citations.map(
                              (citation) => (
                                <p
                                  className="break-all text-xs text-muted-foreground"
                                  key={citation.snapshotId}
                                >
                                  {citation.platform} ·{" "}
                                  {displayWindow(
                                    citation.windowStart,
                                    citation.windowEnd,
                                  )}{" "}
                                  · {citation.source}
                                </p>
                              ),
                            )}
                          </div>
                        </EvidenceDisclosure>
                      </div>
                    </div>
                  </details>
                </>
              )}
              {!hasDailyPerformance && Boolean(content.data?.totalPosts) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Published content performance
                    </CardTitle>
                    <CardDescription>
                      Cumulative captured metrics for posts published{" "}
                      {startDate}–{endDate}. Available measurements only; reach
                      across posts is not unique people.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Metric
                      label="Published posts"
                      value={String(content.data?.totalPosts || 0)}
                    />
                    {(["reach", "engagements", "views"] as const).map((key) => (
                      <Metric
                        key={key}
                        label={`Post ${key}${key === "reach" ? " sum" : ""}`}
                        value={
                          Number(content.data?.metricCoverage?.[key]) > 0
                            ? compact(content.data?.metricTotals?.[key])
                            : "Unavailable"
                        }
                      />
                    ))}
                  </CardContent>
                </Card>
              )}
              {!hasDailyPerformance &&
                Boolean(content.data?.timeline.length) && (
                  <PublishingTrend
                    trends={[]}
                    timeline={content.data?.timeline || []}
                    startDate={startDate}
                    endDate={endDate}
                  />
                )}
<details className="rounded-xl border bg-card px-4 py-3"><summary className="cursor-pointer text-xs font-medium">Published content and post contributions</summary><div className="mt-4">              {content.supported && (
                <ContentOverview
                  data={content.data}
                  credentialId={credentialId}
                  onDay={(date) => {
                    setContentDay(date);
                    setActiveTab("content");
                    updateQuery({ tab: "content" });
                  }}
                  onBrowse={() => {
                    setContentDay(null);
                    setActiveTab("content");
                    updateQuery({ tab: "content" });
                  }}
                />
              )}</div></details>
              {!hasDailyPerformance && Boolean(content.data?.totalPosts) && (
                <BestTimeCard value={dashboard?.bestTime || null} />
              )}
              {!hasDailyPerformance &&
                Boolean(
                  dashboard?.trends.some((point) => point.followers != null),
                ) && (
                  <GrowthReporting
                    trends={dashboard!.trends}
                    previousPeriod={dashboard!.previousPeriod}
                    content={content.data}
                    startDate={startDate}
                    endDate={endDate}
                  />
                )}
              {content.supported && (
                <ContentTestRecommendation content={content.data} />
              )}
              {content.supported && content.error && (
                <p role="alert" className="text-sm text-destructive">
                  Posts: {content.error}
                </p>
              )}
            </TabsContent>
            {content.supported && (
              <TabsContent value="content" className="mt-5">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
                  <p className="text-sm text-muted-foreground">
                    {contentDay
                      ? `Posts published on ${contentDay}`
                      : showFullPostHistory
                        ? "Showing all captured posts, including posts older than the account metrics period."
                        : `Showing posts published ${startDate}–${endDate}.`}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setContentDay(null);
                      setShowAllCapturedPosts(!showFullPostHistory);
                    }}
                  >
                    {showFullPostHistory ? "Use selected period" : "Show all captured posts"}
                  </Button>
                </div>
                <ContentFeed
                  key={`${platform}:${credentialId}`}
                  credentialId={credentialId}
                  startDate={feedStartDate}
                  endDate={feedEndDate}
                  data={feedContent.data}
                  loading={feedContent.loading}
                  error={feedContent.error}
                  load={feedContent.load}
                  day={contentDay}
                  clearDay={() => setContentDay(null)}
                />
              </TabsContent>
            )}

            <TabsContent value="listening" className="mt-5">
              <SocialListeningPanel
                coverage={content.data?.sync?.limitations}
                key={`${platform}:${credentialId}`}
                platform={platform}
                credentialId={credentialId}
                startDate={startDate}
                endDate={endDate}
                revision={contentRevision}
              />
            </TabsContent>

            <TabsContent value="competitors" className="mt-5 space-y-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold">Competitor benchmarks</h2>
                  <p className="text-sm text-muted-foreground">
                    Compare only normalized metrics backed by public or official
                    evidence.
                  </p>
                </div>
                <Button
                  onClick={() => {
                    setEditingCompetitor(null);
                    setCompetitorHandle("");
                    setCompetitorUrl("");
                    setCompetitorOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add competitor
                </Button>
              </div>
              <div className={styles.competitorGrid}>
                {competitors.length ? (
                  competitors.map((competitor) => (
                    <CompetitorCard
                      key={competitor.id}
                      competitor={competitor}
                      benchmark={benchmarks[competitor.id]}
                      busy={busy}
                      onEdit={() => {
                        setEditingCompetitor(competitor);
                        setCompetitorHandle(competitor.public_handle);
                        setCompetitorUrl(competitor.public_url);
                        setCompetitorOpen(true);
                      }}
                      onDelete={() => setDeletingCompetitor(competitor)}
                      onArchive={() =>
                        void run(async () => {
                          await api.patch(
                            `/api/social-analytics/competitors/${competitor.id}`,
                            { isActive: !competitor.is_active },
                          );
                          await loadSupporting();
                        })
                      }
                      onRefresh={
                        platform === "instagram" && credentialId
                          ? () =>
                              void run(async () => {
                                const result = await api.post<{
                                  limitations?: string[];
                                }>(
                                  `/api/social-analytics/competitors/${competitor.id}/refresh`,
                                  { credentialId: Number(credentialId) },
                                );
                                setNotice(
                                  result.limitations?.join(" ") ||
                                    "Public competitor metrics refreshed. Private reach and engagement metrics are not available from public profiles.",
                                );
                                await loadSupporting();
                              })
                          : undefined
                      }
                      onEvidence={() => {
                        setEvidenceCompetitor(competitor);
                        setCompetitorSnapshotUrl(competitor.public_url);
                      }}
                    />
                  ))
                ) : (
                  <Card className="lg:col-span-2">
                    <EmptyBlock
                      icon={Users}
                      title="No competitors saved"
                      text="Add a public competitor profile, then attach comparable official or public-export evidence."
                    />
                  </Card>
                )}
              </div>
              {competitors.length > 0 && <section className="overflow-hidden rounded-xl border bg-card"><div className="border-b px-4 py-3"><h3 className="text-sm font-semibold">Competitor evidence summary</h3><p className="mt-1 text-xs text-muted-foreground">Current public snapshots and returned measurements. Point-in-time counts do not establish period growth.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr>{["Competitor", "Handle", "Public followers", "Captured at", "Metric coverage", "Status"].map(label => <th key={label} scope="col" className="px-4 py-3">{label}</th>)}</tr></thead><tbody>{competitors.map(competitor => <tr className="border-t" key={competitor.id}><td className="px-4 py-3 font-medium"><a className="hover:text-primary hover:underline" href={competitor.public_url} target="_blank" rel="noreferrer">{competitor.display_name || competitor.public_handle}</a></td><td className="px-4 py-3 text-muted-foreground">@{competitor.public_handle}</td><td className="px-4 py-3 font-semibold tabular-nums">{competitor.latest_public_snapshot?.metrics.followers == null ? "—" : compact(competitor.latest_public_snapshot.metrics.followers)}</td><td className="px-4 py-3 text-muted-foreground">{competitor.latest_public_snapshot ? new Date(competitor.latest_public_snapshot.capturedAt).toLocaleDateString() : "Not captured"}</td><td className="px-4 py-3"><div className="flex flex-wrap gap-1">{competitor.latest_public_snapshot ? Object.keys(competitor.latest_public_snapshot.metrics).map(metric => <Badge variant="secondary" className="text-[10px] capitalize" key={metric}>{metric.replaceAll("_", " ")}</Badge>) : "No public measurements"}</div></td><td className="px-4 py-3">{competitor.is_active ? "Tracking" : "Archived"}</td></tr>)}</tbody></table></div></section>}
            </TabsContent>

            <TabsContent value="reports" className="mt-5">
              <SocialReportsPanel
                platform={platform}
                accountIdentifier={selectedAccountIdentifier}
                accountName={selectedAccount?.accountName}
                startDate={startDate}
                endDate={endDate}
                timezone={timezone}
                revision={contentRevision}
              />
            </TabsContent>
          </>
          )}
        </section>
      </div>
      </Tabs>

      <Sheet open={connectionsOpen} onOpenChange={setConnectionsOpen}>
        <SheetContent
          overlayClassName={styles.drawerOverlay} className={styles.drawer}
          onOpenAutoFocus={connectionsReturnFocus.onOpenAutoFocus}
          onCloseAutoFocus={connectionsReturnFocus.onCloseAutoFocus}
        >
          <SheetHeader>
            <SheetTitle>Data &amp; connections</SheetTitle>
            <SheetDescription>
              Choose the official account and measurement window used by Social
              Insights.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-5">
            <p className="break-all text-xs text-muted-foreground">
              Account ID: {selectedAccountIdentifier || "No account selected"}
            </p>
            {dashboard?.sync && (
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  Automatic sync:{" "}
                  {dashboard.sync.status === "running"
                    ? "In progress"
                    : dashboard.sync.status === "failed"
                      ? "Needs attention"
                      : "Up to date"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Last successful sync:{" "}
                  {dashboard.sync.last_succeeded_at
                    ? new Date(
                        dashboard.sync.last_succeeded_at,
                      ).toLocaleString()
                    : "Not yet completed"}
                </p>
                <p className="text-muted-foreground">
                  Next check:{" "}
                  {dashboard.sync.next_due_at
                    ? new Date(dashboard.sync.next_due_at).toLocaleString()
                    : "Within 30 minutes"}
                </p>
              </div>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  Official provider sync
                </CardTitle>
                <CardDescription>
                  {analyticsUnavailable
                    ? selectedAccount?.analyticsReadinessMessage
                    : "Connected accounts sync automatically every 30 minutes. Use Sync official data to refresh this date range now."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Field label="Timezone">
                  <Input
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    aria-invalid={!isIanaTimezone(timezone)}
                  />
                </Field>
                <Button
                  className="w-full"
                  disabled={
                    busy ||
                    accountsLoading ||
                    Boolean(windowError) ||
                    !credentialId ||
                    analyticsUnavailable ||
                    !isIanaTimezone(timezone)
                  }
                  onClick={(event) => void syncOfficialData(event.currentTarget)}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Sync official data
                </Button>
                {analyticsUnavailable && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void reconnectForAnalytics()}
                  >
                    Reconnect {platform} for analytics
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={
                    busy ||
                    analyticsUnavailable ||
                    !selectedAccount?.accountIdentifier ||
                    (!dashboard?.freshness.snapshotCount &&
                      !content.data?.totalPosts) ||
                    !isIanaTimezone(timezone)
                  }
                  onClick={() =>
                    void run(async () => {
                      await api.post("/api/social-analytics/best-times", {
                        platform,
                        accountIdentifier: selectedAccount?.accountIdentifier,
                        timezone,
                      });
                      setNotice("Best-time recommendation updated.");
                      await loadDashboard();
                    })
                  }
                >
                  <CalendarClock className="mr-2 h-4 w-4" />
                  Recompute best time
                </Button>
              </CardContent>
            </Card>
            {
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Database className="h-4 w-4" />
                    Evidence inventory
                  </CardTitle>
                  <CardDescription>
                    Immutable normalized snapshots supporting the visible
                    claims.
                  </CardDescription>
                </CardHeader>
                <CardContent className="max-h-[360px] divide-y overflow-y-auto p-0">
                  {snapshots.length ? (
                    snapshots.map((snapshot) => (
                      <div className="p-4" key={snapshot.id}>
                        <p className="text-sm font-medium">
                          {snapshot.platform} ·{" "}
                          {displayWindow(
                            snapshot.metric_window_start,
                            snapshot.metric_window_end,
                          )}
                        </p>
                        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                          {snapshot.id} · {snapshot.source}/
                          {snapshot.source_snapshot_id}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {Object.entries(snapshot.metrics)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(" · ")}
                        </p>
                      </div>
                    ))
                  ) : (
                    <EmptyBlock
                      icon={Database}
                      title="No evidence snapshots"
                      text="Run an official sync to capture the first measurement window."
                    />
                  )}
                </CardContent>
              </Card>
            }
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={competitorOpen} onOpenChange={setCompetitorOpen}>
        <SheetContent overlayClassName={styles.drawerOverlay} className={styles.drawer}>
          <SheetHeader>
            <SheetTitle>
              {editingCompetitor ? "Edit competitor" : "Add competitor"}
            </SheetTitle>
            <SheetDescription>
              Use a public profile backed by an HTTPS source.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-5">
            <Field label="Public handle">
              <Input
                value={competitorHandle}
                onChange={(event) => setCompetitorHandle(event.target.value)}
                placeholder="brandhandle"
              />
            </Field>
            <Field label="Public profile URL">
              <Input
                value={competitorUrl}
                onChange={(event) => setCompetitorUrl(event.target.value)}
                placeholder="https://…"
                aria-invalid={
                  Boolean(competitorUrl) && !isHttpsUrl(competitorUrl)
                }
              />
            </Field>
            <div className="flex justify-end gap-2 border-t pt-4"><Button variant="outline" onClick={() => setCompetitorOpen(false)}>Cancel</Button>
            <Button
              disabled={
                busy || !competitorHandle.trim() || !isHttpsUrl(competitorUrl)
              }
              onClick={() =>
                void run(async () => {
                  const body = {
                    platform,
                    publicHandle: competitorHandle,
                    publicUrl: competitorUrl,
                  };
                  if (editingCompetitor)
                    await api.patch(
                      `/api/social-analytics/competitors/${editingCompetitor.id}`,
                      body,
                    );
                  else
                    await api.post("/api/social-analytics/competitors", body);
                  setCompetitorHandle("");
                  setCompetitorUrl("");
                  setCompetitorOpen(false);
                  setNotice("Competitor saved.");
                  await loadSupporting();
                })
              }
            >
              {editingCompetitor ? "Save changes" : "Add competitor"}
            </Button></div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog
        open={Boolean(deletingCompetitor)}
        onOpenChange={(open) => {
          if (!open) setDeletingCompetitor(null);
        }}
      >
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle>
              Delete{" "}
              {deletingCompetitor?.display_name ||
                deletingCompetitor?.public_handle}
              ?
            </DialogTitle>
            <DialogDescription>
              Competitors can be deleted before evidence is captured. Captured
              evidence is preserved; archive a competitor to stop tracking and
              keep its history.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert">{error}</p>}
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.delete(
                  `/api/social-analytics/competitors/${deletingCompetitor!.id}`,
                );
                setDeletingCompetitor(null);
                await loadSupporting();
              })
            }
          >
            Delete competitor
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(evidenceCompetitor)}
        onOpenChange={(open) => {
          if (!open) setEvidenceCompetitor(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add competitor evidence</DialogTitle>
            <DialogDescription>
              Enter public metrics for {startDate}–{endDate}. Comparisons use
              the same workspace reporting period and retain the source URL.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="HTTPS source URL">
              <Input
                value={competitorSnapshotUrl}
                onChange={(event) =>
                  setCompetitorSnapshotUrl(event.target.value)
                }
                aria-invalid={!isHttpsUrl(competitorSnapshotUrl)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {Object.keys(competitorMetrics).map((metric) => (
                <Field key={metric} label={metric.replaceAll("_", " ")}>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={competitorMetrics[metric]}
                    onChange={(event) =>
                      setCompetitorMetrics((current) => ({
                        ...current,
                        [metric]: event.target.value,
                      }))
                    }
                    placeholder="Optional"
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Use values shown by the cited public or official export. Leave
              unavailable metrics blank.
            </p>
            <Button
              className="w-full"
              disabled={
                busy ||
                !evidenceCompetitor ||
                !isHttpsUrl(competitorSnapshotUrl) ||
                !Object.values(competitorMetrics).some(Boolean)
              }
              onClick={() =>
                void run(async () => {
                  const metrics = Object.fromEntries(
                    Object.entries(competitorMetrics)
                      .filter(([, value]) => value !== "")
                      .map(([key, value]) => [key, Number(value)]),
                  );
                  await api.post(
                    `/api/social-analytics/competitors/${evidenceCompetitor?.id}/snapshots`,
                    {
                      source: "public_export",
                      sourceUrl: competitorSnapshotUrl,
                      metrics,
                      metricWindowStart: `${startDate}T00:00:00.000Z`,
                      metricWindowEnd: `${endDate}T23:59:59.999Z`,
                    },
                  );
                  setEvidenceCompetitor(null);
                  setCompetitorMetrics((current) =>
                    Object.fromEntries(
                      Object.keys(current).map((key) => [key, ""]),
                    ),
                  );
                  setNotice(
                    "Competitor evidence added for the selected reporting period.",
                  );
                  await loadSupporting();
                })
              }
            >
              Save cited evidence
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function AccountFreshness({
  state,
  title,
  detail,
  action,
}: {
  state: string;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={`${styles.notice} flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card text-xs text-muted-foreground`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${state === "fresh" ? "bg-emerald-500" : state === "error" ? "bg-destructive" : "bg-amber-500"}`}
        />
        <span>{title}</span>
        <span>· {detail}</span>
      </div>
      {action}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <p className="text-xs font-medium capitalize text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </p>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
function OverviewSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading social insights">
      <div className="h-28 animate-pulse rounded-xl bg-muted" />
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="h-80 animate-pulse rounded-xl bg-muted" />
        <div className="h-80 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
function EmptySocialState({
  connected,
  analyticsReady,
  onAction,
}: {
  connected: boolean;
  analyticsReady: boolean;
  onAction: (opener: HTMLButtonElement | null) => void;
}) {
  const permissionRequired = connected && !analyticsReady;
  const actionOpener = useRef<HTMLButtonElement | null>(null);
  return (
    <div onClickCapture={(event) => {
      // PerformanceEmptyState's callback omits the event. Capture its actual
      // action button first, including pointer activations that do not focus it.
      const target = event.target;
      actionOpener.current = target instanceof Element ? target.closest<HTMLButtonElement>("button") : null;
    }}>
    <PerformanceEmptyState
      icon={Gauge}
      title={
        permissionRequired
          ? "Organic analytics will appear after reconnecting"
          : connected
            ? "Sync your first social measurement"
            : "Connect and sync an account"
      }
      description={
        permissionRequired
          ? "This account is still connected for other features. Use the account status above to restore organic analytics access."
          : connected
            ? "The account is connected. Run an official sync to show trends, best times, and evidence-backed recommendations."
            : "Social Insights needs official first-party measurements before it can show trends or recommendations."
      }
      actionLabel={
        permissionRequired
          ? undefined
          : connected
            ? "Sync official data"
            : "Open data & connections"
      }
      onAction={permissionRequired ? undefined : () => onAction(actionOpener.current)}
    />
    </div>
  );
}
function EmptyBlock({
  icon: Icon,
  title,
  text,
}: {
  icon: React.ElementType;
  title: string;
  text: string;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <Icon className="h-7 w-7 text-muted-foreground" />
      <p className="mt-3 font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
function BestTimeCard({ value }: { value: BestTime | null }) {
  const slots = value?.recommended_slots || [];
  const maximum = Math.max(1, ...slots.map(slot => Number(slot.averageEngagement) || 0));
  const weekdays = [1, 2, 3, 4, 5, 6, 0];
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><CalendarClock className="h-4 w-4"/>Best time to publish</CardTitle><CardDescription>{value ? `${value.sample_size} measured posts · ${value.timezone} · ${Math.round(Number(value.confidence) * 100)}% evidence score` : "Measured post timestamps are needed to calculate publishing times."}</CardDescription></CardHeader>
    <CardContent>
      {!value ? <EmptyBlock icon={CalendarClock} title="No timing recommendation" text="Open Data & connections after the first sync to calculate the best time."/> : value.fallback_used ? <Callout tone="warning" size="sm" title="Early estimate">Daily account totals cannot determine publishing hours. At least 8 measured posts across 3 local time slots are needed. Timing associations do not establish causation.</Callout> : <>
        <div className="overflow-x-auto"><div className="min-w-[350px]" role="img" aria-label="Measured publishing time slots by weekday and local hour">
          <div className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] gap-1 text-[8px] text-muted-foreground"><span/>{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>)}</div>
          {weekdays.map(day => <div className="mt-1 grid grid-cols-[28px_repeat(24,minmax(0,1fr))] items-center gap-1" key={day}><span className="text-[9px] text-muted-foreground">{days[day]}</span>{Array.from({ length: 24 }, (_, hour) => {
            const slot = slots.find(item => item.dayOfWeek === day && item.hour === hour);
            const measured = slot?.averageEngagement != null && Number.isFinite(Number(slot.averageEngagement));
            return <span key={hour} className="block h-3.5 rounded-sm" style={{ background: measured ? `hsl(var(--primary) / ${.15 + .75 * Number(slot!.averageEngagement) / maximum})` : "hsl(var(--muted))" }} title={`${days[day]} ${String(hour).padStart(2, "0")}:00 · ${measured ? `${slot!.averageEngagement} average engagements; ${slot!.observations || 0} observations` : "No measured slot returned"}`}/>;
          })}</div>)}
        </div></div><p className="mt-2 text-[10px] text-muted-foreground">Blue intensity shows measured engagement. Gray slots have no returned measurements.</p>
      </>}
      {value && <details className="mt-3 text-[11px] text-muted-foreground"><summary className="cursor-pointer font-medium">Timing methodology and measured slots</summary>{value.methodology && <p className="mt-2">{value.methodology}</p>}<ul className="mt-2 space-y-1">{slots.map((slot, index) => <li key={`${slot.dayOfWeek}:${slot.hour}`}>{index + 1}. {days[slot.dayOfWeek]} at {String(slot.hour).padStart(2, "0")}:00 · {slot.observations || 0} observations · {slot.averageEngagement ?? "Unavailable"} average engagements</li>)}</ul></details>}
    </CardContent>
  </Card>;
}

function CompetitorCard({
  competitor,
  benchmark,
  onEvidence,
  onEdit,
  onDelete,
  onArchive,
  onRefresh,
  busy,
}: {
  competitor: Competitor;
  benchmark?: CompetitorBenchmark;
  onEvidence: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onRefresh?: () => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {competitor.display_name || `@${competitor.public_handle}`}
            </CardTitle>
            <CardDescription className="capitalize">
              {competitor.platform}
              {!competitor.is_active ? " · Archived" : ""}
            </CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <a href={competitor.public_url} target="_blank" rel="noreferrer">
              <Eye className="mr-2 h-4 w-4" />
              Profile
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {competitor.last_refresh_status && (
          <p className="mb-3 text-xs text-muted-foreground">
            Public refresh: {competitor.last_refresh_status}
            {competitor.last_refresh_attempt_at
              ? ` · ${new Date(competitor.last_refresh_attempt_at).toLocaleString()}`
              : ""}
            {competitor.last_refresh_error
              ? ` · ${competitor.last_refresh_error}`
              : ""}
          </p>
        )}
        {competitor.latest_public_snapshot && (
          <div className="mb-4 rounded-lg border border-primary/10 bg-primary/[.025] p-3">
            <p className="text-sm font-medium">
              Current public followers<span className="mt-1 block text-2xl font-semibold tracking-tight">{compact(competitor.latest_public_snapshot.metrics.followers)}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Captured{" "}
              {new Date(
                competitor.latest_public_snapshot.capturedAt,
              ).toLocaleString()}
              . Point-in-time count; no period comparison.
            </p>
          </div>
        )}
        {benchmark?.benchmark ? (
          <div className="grid grid-cols-2 gap-2">
            {benchmark.benchmark.metrics.slice(0, 6).map((metric) => (
              <div className="rounded-lg border p-3" key={metric.metric}>
                <p className="text-xs capitalize text-muted-foreground">
                  {metric.metric.replaceAll("_", " ")}
                </p>
                <p
                  className={`mt-1 font-mono font-semibold ${metric.delta >= 0 ? "text-emerald-600" : "text-amber-600"}`}
                >
                  {metric.percentDelta === null
                    ? "—"
                    : `${metric.percentDelta > 0 ? "+" : ""}${metric.percentDelta}%`}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  You {compact(metric.workspace)} · them{" "}
                  {compact(metric.competitor)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed p-2 text-xs text-muted-foreground">
            {benchmark?.reason || "Comparable evidence has not been added yet."}
          </p>
        )}
        {
          <Button
            className="mt-4 w-full"
            variant="outline"
            onClick={onEvidence}
          >
            <Database className="mr-2 h-4 w-4" />
            Add evidence
          </Button>
        }
        <div className="mt-3 flex flex-wrap gap-2">
          {onRefresh && competitor.is_active && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onRefresh}
              aria-label="Refresh public metrics"
              title="Refresh public metrics"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true"/>
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onArchive}>
            {competitor.is_active ? "Archive" : "Restore"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
        </div>
        <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Public data coverage</summary><p className="mt-2 leading-5">
          {competitor.platform === "instagram"
            ? "Active profiles refresh daily through a connected Instagram account. Only public business/creator metrics are available; private reach is unavailable."
            : "Use a cited public export for comparison; automatic private competitor analytics are unavailable."}
        </p></details>
      </CardContent>
    </Card>
  );
}

function GrowthReporting({
  compactView = false,
  trends,
  previousPeriod,
  content,
  startDate,
  endDate,
}: {
  compactView?: boolean;
  trends: Dashboard["trends"];
  previousPeriod: Dashboard["previousPeriod"];
  content: SocialContentData | null;
  startDate: string;
  endDate: string;
}) {
  const followerPoints = trends.filter((point) => point.followers != null);
  const first = followerPoints[0]?.followers;
  const last = followerPoints.at(-1)?.followers;
  const followerDelta =
    followerPoints.length >= 2 && first != null && last != null
      ? last - first
      : null;
  const currentFollowers = last ?? null;
  const priorFollowers = previousPeriod?.summary.followers ?? null;
  const periodFollowerChange =
    currentFollowers != null && priorFollowers != null
      ? currentFollowers - priorFollowers
      : null;
  const currentEngagementRate =
    (trends.reduce(
      (total, point) => total + Number(point.engagements || 0),
      0,
    ) /
      Math.max(
        1,
        trends.reduce(
          (total, point) =>
            total + Number(point.reach || point.impressions || 0),
          0,
        ),
      )) *
    100;
  const priorEngagementRate = previousPeriod?.summary.engagement_rate;
  const engagementRateChange =
    priorEngagementRate == null
      ? null
      : currentEngagementRate - priorEngagementRate;
  const daysInRange = Math.max(
    1,
    Math.floor(
      (Date.parse(`${endDate}T00:00:00Z`) -
        Date.parse(`${startDate}T00:00:00Z`)) /
        86400000,
    ) + 1,
  );
  const perWeek = Number(
    (((content?.totalPosts || 0) * 7) / daysInRange).toFixed(1),
  );
  const formats = new Map(
    (content?.formats || []).map((row) => [
      row.type,
      {
        count: row.posts,
        reach: Number(row.metricTotals.reach || 0),
        engagements: Number(row.metricTotals.engagements || 0),
        reachCount: Number(row.metricCoverage.reach || 0),
        engagementCount: Number(row.metricCoverage.engagements || 0),
      },
    ]),
  );
  const ranked = [...formats.entries()].sort(
    (a, b) =>
      b[1].engagements / Math.max(1, b[1].engagementCount) -
      a[1].engagements / Math.max(1, a[1].engagementCount),
  );
  if (compactView) {
    const maximum = Math.max(1, ...ranked.map(([, row]) => row.reach / Math.max(1, row.reachCount)));
    return <Card><CardHeader><CardTitle className="text-sm">Posting format comparison</CardTitle><CardDescription>Average reach per post with a returned reach measurement.</CardDescription></CardHeader><CardContent>
      <div className="space-y-3">{ranked.map(([format, row]) => <div className="flex items-center gap-3 text-xs" key={format}><span className="w-16 shrink-0 capitalize">{format}</span><span className="h-2 flex-1 overflow-hidden rounded-full bg-primary/5"><span className="block h-full rounded-full bg-primary/60" style={{ width: `${row.reachCount ? Math.max(2, row.reach / row.reachCount / maximum * 100) : 0}%` }}/></span><strong className="w-14 text-right tabular-nums">{row.reachCount ? compact(row.reach / row.reachCount) : "—"}</strong></div>)}{!ranked.length && <p className="text-xs text-muted-foreground">Sync published content to compare format performance.</p>}</div>
      <details className="mt-4 text-[11px] text-muted-foreground"><summary className="cursor-pointer font-medium">Follower movement, comparisons and coverage</summary><p className="mt-2">Comparisons use the immediately preceding equal-length window. Follower movement requires at least two captured days. Format rankings use captured posts and available measurements.</p>      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Metric
            label="Follower movement in window"
            value={
              followerDelta == null
                ? "Unavailable"
                : `${followerDelta >= 0 ? "+" : ""}${compact(followerDelta)}`
            }
          />
          <Metric
            label="Followers vs prior period"
            value={
              periodFollowerChange == null
                ? "Unavailable"
                : `${periodFollowerChange >= 0 ? "+" : ""}${compact(periodFollowerChange)}`
            }
          />
          <Metric
            label="Engagement rate vs prior"
            value={
              engagementRateChange == null
                ? "Unavailable"
                : `${engagementRateChange >= 0 ? "+" : ""}${engagementRateChange.toFixed(1)} pts`
            }
          />
          <Metric label="Posts per week" value={String(perWeek)} />
          <Metric label="Captured formats" value={String(formats.size)} />
        </div>
        {ranked.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2">Format</th>
                  <th className="pb-2">Items</th>
                  <th className="pb-2">Average reach</th>
                  <th className="pb-2">Average engagements</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(([format, row]) => (
                  <tr className="border-t" key={format}>
                    <td className="py-2 capitalize">{format}</td>
                    <td className="py-2">{row.count}</td>
                    <td className="py-2">
                      {row.reachCount
                        ? compact(row.reach / row.reachCount)
                        : "Unavailable"}
                    </td>
                    <td className="py-2">
                      {row.engagementCount
                        ? compact(row.engagements / row.engagementCount)
                        : "Unavailable"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sync published content to compare format performance.
          </p>
        )}
      </CardContent></details>
    </CardContent></Card>;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Growth and publishing pattern
        </CardTitle>
        <CardDescription>
          Follower movement, previous-period change, posting frequency, and
          format performance. Comparisons use the immediately preceding
          equal-length window; format rankings use all matching captured posts
          and only available measurements. Follower change needs at least two
          captured days; historical follower counts cannot be reconstructed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Metric
            label="Follower movement in window"
            value={
              followerDelta == null
                ? "Unavailable"
                : `${followerDelta >= 0 ? "+" : ""}${compact(followerDelta)}`
            }
          />
          <Metric
            label="Followers vs prior period"
            value={
              periodFollowerChange == null
                ? "Unavailable"
                : `${periodFollowerChange >= 0 ? "+" : ""}${compact(periodFollowerChange)}`
            }
          />
          <Metric
            label="Engagement rate vs prior"
            value={
              engagementRateChange == null
                ? "Unavailable"
                : `${engagementRateChange >= 0 ? "+" : ""}${engagementRateChange.toFixed(1)} pts`
            }
          />
          <Metric label="Posts per week" value={String(perWeek)} />
          <Metric label="Captured formats" value={String(formats.size)} />
        </div>
        {ranked.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2">Format</th>
                  <th className="pb-2">Items</th>
                  <th className="pb-2">Average reach</th>
                  <th className="pb-2">Average engagements</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(([format, row]) => (
                  <tr className="border-t" key={format}>
                    <td className="py-2 capitalize">{format}</td>
                    <td className="py-2">{row.count}</td>
                    <td className="py-2">
                      {row.reachCount
                        ? compact(row.reach / row.reachCount)
                        : "Unavailable"}
                    </td>
                    <td className="py-2">
                      {row.engagementCount
                        ? compact(row.engagements / row.engagementCount)
                        : "Unavailable"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sync published content to compare format performance.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ContentTestRecommendation({
  content,
}: {
  content: SocialContentData | null;
}) {
  const ranked = (content?.formats || [])
    .filter(
      (row) =>
        row.posts >= 2 &&
        Number(row.metricCoverage.reach) === row.posts &&
        Number(row.metricCoverage.engagements) === row.posts &&
        Number(row.metricTotals.reach) > 0,
    )
    .sort(
      (a, b) =>
        Number(b.metricTotals.engagements) / Number(b.metricTotals.reach) -
        Number(a.metricTotals.engagements) / Number(a.metricTotals.reach),
    );
  const winner = ranked[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Evidence-backed content test
        </CardTitle>
        <CardDescription>
          {winner
            ? `Test another ${winner.type}. Across all ${winner.posts} captured ${winner.type} posts, measured engagements were ${((100 * Number(winner.metricTotals.engagements)) / Number(winner.metricTotals.reach)).toFixed(1)} per 100 reach. These are cumulative post metrics for content published in the selected window, not activity restricted to that window. This is a descriptive association, not a forecast.`
            : "At least two posts in a format, each with measured reach and engagements, are needed before suggesting a format test."}
        </CardDescription>
      </CardHeader>
      {winner && (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Review this format in Posts &amp; comments to inspect the underlying
            content and source links.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function socialFollowerMovement(trends: Dashboard["trends"]) {
  const measured = trends.filter(point => point.followers != null);
  if (measured.length < 2) return "Unavailable";
  const change = Number(measured.at(-1)!.followers) - Number(measured[0].followers);
  return `${change >= 0 ? "+" : ""}${compact(change)}`;
}
