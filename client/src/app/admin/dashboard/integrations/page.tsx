"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api, buildApiUrl } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Brain,
  Globe,
  Server,
  ShieldCheck,
  Mail,
  Send,
  IndianRupee,
  ArrowRight,
  CheckCircle,
  XCircle,
  Settings,
  Key,
  RefreshCw,
  Image,
  Video,
  Webhook,
  Database,
  History,
} from "lucide-react";

interface Credential {
  id: number;
  platform: string;
  name: string;
  isActive: boolean;
  validationStatus?: "valid" | "invalid" | "manual_required" | null;
}

interface CredentialAuditEntry {
  id: number;
  credentialId: number | null;
  platform: string;
  action: string;
  adminName: string | null;
  changedFields: string[];
  validationStatus: "valid" | "invalid" | "manual_required" | null;
  message: string | null;
  createdAt: string;
}

interface PlatformConfig {
  name: string;
  icon: React.ElementType;
  color: string;
  gradient: string;
  bgGradient: string;
  description: string;
  features: string[];
  statsPlatforms?: string[];
  webhookPath?: string;
}

const PLATFORMS: Record<string, PlatformConfig> = {
  "llm": {
    name: "LLM Providers",
    icon: Brain,
    color: "bg-gradient-to-r from-emerald-500 to-purple-500",
    gradient: "from-emerald-500 to-purple-600",
    bgGradient: "from-emerald-500/10 to-purple-600/10",
    description: "OpenAI, Gemini Developer API, Google Vertex AI, OpenRouter, and custom AI providers",
    features: ["OpenAI", "Gemini", "Vertex AI", "OpenRouter", "Custom AI"],
    // Aggregate stats from openai + openrouter + custom_ai + gemini (LLM)
    statsPlatforms: ["openai", "openrouter", "custom_ai", "gemini"],
  },
  "intent-classifier": {
    name: "Intent Classifier",
    icon: Brain,
    color: "bg-purple-600",
    gradient: "from-purple-600 to-blue-600",
    bgGradient: "from-purple-600/10 to-blue-600/10",
    description: "Prioritized intent-classifier credentials with validation and fallback across providers",
    features: ["OpenRouter", "OpenAI", "Gemini", "Vertex AI", "Custom AI", "Priority fallback"],
    statsPlatforms: [],
  },
  apify: {
    name: "Apify",
    icon: Server,
    color: "bg-orange-500",
    gradient: "from-orange-500 to-orange-700",
    bgGradient: "from-orange-500/10 to-orange-700/10",
    description: "Web scraping and data extraction for lead generation",
    features: ["Web Scraping", "Lead Generation", "Data Extraction"],
  },
  "gemini-image": {
    name: "Gemini Image",
    icon: Image,
    color: "bg-indigo-500",
    gradient: "from-indigo-500 to-indigo-700",
    bgGradient: "from-indigo-500/10 to-indigo-700/10",
    description: "Gemini & Vertex AI keys for image generation",
    features: ["Image Generation", "Gemini API", "Vertex AI"],
    statsPlatforms: ["gemini_image"],
  },
  "gemini-video": {
    name: "Gemini Video",
    icon: Video,
    color: "bg-violet-500",
    gradient: "from-violet-500 to-violet-700",
    bgGradient: "from-violet-500/10 to-violet-700/10",
    description: "Gemini & Vertex AI keys for video generation",
    features: ["Video Generation", "Gemini API", "Vertex AI"],
    statsPlatforms: ["gemini_video"],
  },
  zerobounce: {
    name: "ZeroBounce",
    icon: ShieldCheck,
    color: "bg-cyan-500",
    gradient: "from-cyan-500 to-cyan-700",
    bgGradient: "from-cyan-500/10 to-cyan-700/10",
    description: "Email validation and verification service",
    features: ["Email Validation", "Bounce Prevention", "Deliverability"],
  },
  smtp: {
    name: "Email SMTP",
    icon: Mail,
    color: "bg-red-500",
    gradient: "from-red-500 to-red-700",
    bgGradient: "from-red-500/10 to-red-700/10",
    description: "SMTP configuration for OTP, password reset, and notifications",
    features: ["OTP Emails", "Password Reset", "Notifications"],
  },
  resend: {
    name: "Resend",
    icon: Send,
    color: "bg-emerald-600",
    gradient: "from-emerald-600 to-emerald-800",
    bgGradient: "from-emerald-600/10 to-emerald-800/10",
    description: "Resend API for transactional email and custom domain outreach",
    features: ["Custom Domain", "Email Outreach", "Domain Verification"],
    webhookPath: "/api/resend/webhook",
  },
  gmail_oauth: {
    name: "Gmail OAuth",
    icon: Mail,
    color: "bg-orange-500",
    gradient: "from-orange-500 to-red-500",
    bgGradient: "from-orange-500/10 to-red-500/10",
    description: "Google OAuth credentials for Gmail API integration",
    features: ["Gmail API", "OAuth 2.0", "Push Notifications"],
    webhookPath: "/api/gmail/oauth/webhook",
  },
  razorpay: {
    name: "Razorpay",
    icon: IndianRupee,
    color: "bg-blue-600",
    gradient: "from-blue-600 to-blue-800",
    bgGradient: "from-blue-600/10 to-blue-800/10",
    description: "Payment gateway for wallet recharges and wallet top-ups",
    features: ["Wallet Recharge", "UPI / Cards", "Payment Verification"],
  },
  embeddings: {
    name: "Embedding Providers",
    icon: Database,
    color: "bg-gradient-to-r from-teal-500 to-cyan-500",
    gradient: "from-teal-500 to-cyan-600",
    bgGradient: "from-teal-500/10 to-cyan-600/10",
    description: "Vector embeddings for semantic search & RAG knowledge base",
    features: ["Semantic Search", "RAG Context", "OpenAI", "Gemini", "OpenRouter", "Chunk Size", "Overlap"],
    statsPlatforms: ["openai_embedding", "gemini_embedding", "openrouter_embedding"],
  },
  meta_app: {
    name: "Meta App",
    icon: Globe,
    color: "bg-gradient-to-r from-blue-600 to-purple-600",
    gradient: "from-blue-600 to-purple-600",
    bgGradient: "from-blue-600/10 to-purple-600/10",
    description: "Global Meta App for Facebook, Instagram DMs, and Ads OAuth",
    features: ["Facebook Pages", "Instagram DMs", "Meta Ads", "OAuth"],
    webhookPath: "/api/webhooks/instagram",
    statsPlatforms: ["meta_app"],
  },

};

type Platform = keyof typeof PLATFORMS;

const PLATFORM_GROUPS: { title: string; description: string; platforms: Platform[] }[] = [
  {
    title: "AI & Models",
    description: "Language models, routing, generation, and embedding providers.",
    platforms: ["llm", "intent-classifier", "gemini-image", "gemini-video", "embeddings"],
  },
  {
    title: "Communications",
    description: "Email delivery and the global Meta app used by social and ads connections.",
    platforms: ["meta_app", "smtp", "resend", "gmail_oauth"],
  },
  {
    title: "Data Services",
    description: "Lead data collection and email verification providers.",
    platforms: ["apify", "zerobounce"],
  },
  {
    title: "Payments",
    description: "Payment processing and wallet recharge configuration.",
    platforms: ["razorpay"],
  },
];

export default function IntegrationsPage() {
  const [platformStats, setPlatformStats] = useState<
    Record<string, { total: number; active: number; invalid: number }>
  >({});
  const [loading, setLoading] = useState(true);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<CredentialAuditEntry[]>([]);
  const { toast } = useToast();

  const showCopyFailed = () => {
    toast({
      title: "Copy failed",
      description: "Copy the webhook URL manually from the field.",
      variant: "destructive",
    });
  };

  const fetchStatuses = useCallback(async () => {
    try {
      setLoading(true);
      setCredentialsError(null);
      setAuditError(null);
      const [credentialsResult, auditResult, classifierResult] = await Promise.allSettled([
        api.get<{ credentials?: Credential[]; data?: Credential[] }>("/api/admin/integrations"),
        api.get<{ entries: CredentialAuditEntry[] }>("/api/admin/integrations/audit?limit=10"),
        api.get<{ credentials: Credential[] }>("/api/admin/intent-classifier-integrations"),
      ]);
      if (credentialsResult.status === "rejected") {
        setCredentialsError(credentialsResult.reason instanceof Error ? credentialsResult.reason.message : "Integration status could not be loaded.");
        setPlatformStats({});
      }
      if (auditResult.status === "fulfilled") {
        setAuditEntries(auditResult.value.entries || []);
      } else {
        setAuditError(auditResult.reason instanceof Error ? auditResult.reason.message : "Credential activity could not be loaded.");
        setAuditEntries([]);
      }

      if (credentialsResult.status !== "fulfilled") return;
      const data = credentialsResult.value;
      const allCreds: Credential[] = data.credentials || data.data || [];

      // Group by platform
      const stats: Record<string, { total: number; active: number; invalid: number }> = {};
      for (const platform of Object.keys(PLATFORMS)) {
        const config = PLATFORMS[platform as Platform];
        // Some cards aggregate multiple platforms (e.g. AI Providers = openai + openrouter + custom_ai)
        const platformKeys = config.statsPlatforms || [platform];
        const platformCreds = allCreds.filter((c) => platformKeys.includes(c.platform));
        stats[platform] = {
          total: platformCreds.length,
          active: platformCreds.filter((c) => c.isActive).length,
          invalid: platformCreds.filter((c) => c.validationStatus === "invalid").length,
        };
      }
      if (classifierResult.status === "fulfilled") {
        const classifierCredentials = classifierResult.value.credentials || [];
        stats["intent-classifier"] = {
          total: classifierCredentials.length,
          active: classifierCredentials.filter(c => c.isActive).length,
          invalid: classifierCredentials.filter(c => c.validationStatus === "invalid").length,
        };
      }
      setPlatformStats(stats);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load integrations";
      setCredentialsError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const renderPlatformCard = (platform: Platform) => {
    const config = PLATFORMS[platform];
    const stats = platformStats[platform] || { total: 0, active: 0, invalid: 0 };
    const Icon = config.icon;
    const hasActiveKey = stats.active > 0;

    return (
      <Card
        key={platform}
        className="group h-full transition-all hover:border-primary/50 hover:shadow-lg focus-within:border-primary focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
      >
        <div className="flex h-full flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className={`p-3 rounded-lg ${config.color} text-white`}>
                <Icon className="h-6 w-6" />
              </div>
              {stats.invalid > 0 && <Badge variant="destructive">{stats.invalid} invalid</Badge>}
              <div className="flex items-center gap-2">
                {loading ? (
                  <Spinner size="md" label={`Loading ${config.name} status`} className="text-muted-foreground" />
                ) : hasActiveKey ? (
                  <Badge
                    variant="default"
                    className="border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                  >
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Active credential
                  </Badge>
                ) : stats.total > 0 ? (
                  <Badge
                    variant="secondary"
                    className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                  >
                    <XCircle className="h-3 w-3 mr-1" />
                    Inactive
                  </Badge>
                ) : (
                  <Badge variant="outline">
                    <Key className="h-3 w-3 mr-1" />
                    Not Configured
                  </Badge>
                )}
              </div>
            </div>
            <CardTitle className="mt-4">
              <Link
                href={`/admin/dashboard/integrations/${platform}`}
                className="rounded-sm outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                {config.name}
              </Link>
            </CardTitle>
            <CardDescription>{config.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap gap-2">
              {config.features.map((feature) => (
                <Badge key={feature} variant="secondary" className="text-xs">
                  {feature}
                </Badge>
              ))}
            </div>

            {config.webhookPath && (
              <div className="mb-4 rounded-lg border bg-muted/50 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Webhook URL</span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {buildApiUrl(config.webhookPath)}
                  </code>
                  <CopyButton
                    value={buildApiUrl(config.webhookPath)}
                    iconOnly
                    variant="ghost"
                    label={`Copy ${config.name} webhook URL`}
                    className="h-8 w-8 shrink-0 text-muted-foreground"
                    onError={showCopyFailed}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <div className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{stats.active}</span>
                {" / "}<span>{stats.total}</span>{" active keys"}
              </div>
              <Link
                href={`/admin/dashboard/integrations/${platform}`}
                className="flex items-center gap-1 rounded-sm text-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Settings className="h-4 w-4" />
                <span>Configure</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </CardContent>
        </div>
      </Card>
    );
  };

  useEffect(() => {
    fetchStatuses();
  }, [fetchStatuses]);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
            <Settings className="h-8 w-8 text-primary" />
            Platform Integrations
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage system-wide provider credentials and configuration
          </p>
        </div>
        <Button onClick={fetchStatuses} variant="outline" size="icon" className="self-end sm:self-auto" aria-label="Refresh integration status">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <Callout tone="info" title="Global credentials and customer connections">
        Credentials configured here are shared by the platform. Customers&apos; connected Facebook, Instagram, Ads, and Gmail accounts are workspace-scoped; this page shows global app/provider credentials only and does not surface per-customer connection health.
      </Callout>

      {credentialsError && (
        <Callout
          tone="danger"
          title="Integration status could not be loaded"
          actions={<Button variant="outline" size="sm" onClick={() => void fetchStatuses()}>Try again</Button>}
        >
          {credentialsError}
        </Callout>
      )}

      {/* Integration catalog grouped by the kind of system each provider serves. */}
      {!credentialsError && (
        <div className="space-y-9">
          {PLATFORM_GROUPS.map((group) => {
            const activeCount = group.platforms.filter((platform) => (platformStats[platform]?.active || 0) > 0).length;
            const headingId = `integration-group-${group.title.toLowerCase().replaceAll(" & ", "-").replaceAll(" ", "-")}`;
            return (
              <section key={group.title} aria-labelledby={headingId}>
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h2 id={headingId} className="text-lg font-semibold">{group.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
                  </div>
                  {!loading && (
                    <Badge variant="outline" className="w-fit">{activeCount} of {group.platforms.length} active</Badge>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {group.platforms.map(renderPlatformCard)}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary"><History className="h-5 w-5" /></div>
            <div><CardTitle className="text-base">Credential activity</CardTitle><CardDescription>Recent validation, rotation, activation, and deletion events. Secret values are never recorded.</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent>
          {auditError ? (
            <Callout
              tone="danger"
              title="Credential activity could not be loaded"
              actions={<Button variant="outline" size="sm" onClick={() => void fetchStatuses()}>Try again</Button>}
            >
              {auditError}
            </Callout>
          ) : auditEntries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No credential activity has been recorded yet.</p>
          ) : (
            <div className="divide-y divide-border rounded-lg border">
              {auditEntries.map((entry) => (
                <div key={entry.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="capitalize">{entry.platform.replaceAll("_", " ")}</Badge><span className="text-sm font-medium capitalize">{entry.action}</span>{entry.validationStatus && <Badge variant={entry.validationStatus === "invalid" ? "destructive" : "secondary"}>{entry.validationStatus.replaceAll("_", " ")}</Badge>}</div>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={entry.message || undefined}>{entry.message || (entry.changedFields.length ? `Changed: ${entry.changedFields.join(", ")}` : "No credential values retained in audit")}</p>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground sm:text-right"><p>{entry.adminName || "System"}</p><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
