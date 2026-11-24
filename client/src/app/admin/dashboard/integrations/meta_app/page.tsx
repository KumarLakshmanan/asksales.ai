"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  ArrowLeft,
  Save,
  Shield,
  Webhook,
  Users,
  Instagram,
  Facebook,
  BarChart3,
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  BookOpen,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Play,
} from "lucide-react";
import { api, buildApiUrl } from "@/lib/admin-api";

type MetaReviewStatus = "approved" | "testing" | "pending" | "rejected" | "not_requested" | "not_required" | "unknown";

const META_REVIEW_PERMISSIONS = [
  "instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments", "instagram_business_content_publish", "instagram_business_manage_insights",
  "instagram_basic", "pages_show_list", "pages_manage_metadata", "pages_read_engagement", "pages_messaging",
  "pages_manage_posts", "pages_manage_engagement", "pages_read_user_content", "instagram_manage_insights", "instagram_manage_messages", "instagram_manage_comments", "instagram_content_publish",
  "ads_read", "ads_management", "whatsapp_business_messaging", "whatsapp_business_management",
] as const;
type MetaReviewPermission = typeof META_REVIEW_PERMISSIONS[number];
const DEFAULT_REVIEW_STATUS: Record<MetaReviewPermission, MetaReviewStatus> = Object.fromEntries(
  META_REVIEW_PERMISSIONS.map((permission) => [permission,
    ["instagram_basic", "whatsapp_business_messaging", "whatsapp_business_management"].includes(permission) ? "approved" : permission.startsWith("instagram_business_") ? "unknown" : "rejected"]),
) as Record<MetaReviewPermission, MetaReviewStatus>;

// For Meta OAuth callback URLs, prefer ngrok URL in development (Meta doesn't allow localhost)
const buildOAuthCallbackUrl = (endpoint: string): string => {
  return buildApiUrl(endpoint);
};

const deploymentHostname = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || "https://dev.asksales.ai").hostname;
  } catch {
    return "dev.asksales.ai";
  }
})();

interface MetaConfig {
  id?: number;
  appId: string;
  appSecret: string;
  appSecretConfigured?: boolean;
  webhookVerifyToken: string;
  webhookVerifyTokenConfigured?: boolean;
  webhookUrl: string;
  configId?: string;
  apiVersion: string;
  isActive: boolean;
  lastUsedAt?: string;
  createdAt?: string;
  instagramAppId?: string;
  instagramAppSecret?: string;
  instagramAppSecretConfigured?: boolean;
  appReviewPermissions?: Partial<Record<MetaReviewPermission, MetaReviewStatus>>;
}

interface MetaConnection {
  id: number;
  userId: number;
  pageId: string;
  pageName: string;
  instagramUsername?: string;
  instagramAccountId?: string;
  instagramFollowersCount?: number;
  adAccountId?: string;
  adAccountName?: string;
  isActive: boolean;
  webhookSubscribed: boolean;
  lastUsedAt?: string;
  createdAt: string;
}

interface MetaStats {
  totalConnections: number;
  withInstagram: number;
  withAds: number;
  withWebhook: number;
}

interface TokenStatus {
  id: number;
  userId: number;
  platform: string;
  account: string;
  status: 'valid' | 'expiring' | 'expired' | 'unknown';
  expiresAt: string | null;
  lastUpdated: string | null;
}

interface WebhookSummary {
  platform: string;
  total: number;
  processed: number;
  errors: number;
  signatureRejected: number;
  lastEvent: string | null;
}

interface MetaHealth {
  overallStatus: 'healthy' | 'warning' | 'critical';
  tokens: {
    total: number;
    valid: number;
    expiring: number;
    expired: number;
    unknown: number;
    details: TokenStatus[];
  };
  webhooks: {
    last24h: WebhookSummary[];
    totalEvents: number;
    totalErrors: number;
  };
  recentErrors: Array<{
    id: number;
    platform: string;
    eventType: string;
    error: string;
    createdAt: string;
  }>;
  pages: Array<{
    pageId: string;
    pageName: string;
    userId: number;
    hasInstagram: boolean;
    hasAds: boolean;
    webhookSubscribed: boolean;
  }>;
}

interface WebhookEvent {
  id: number;
  platform: string;
  eventType: string | null;
  pageId: string | null;
  userId: number | null;
  payload: unknown;
  signatureValid: boolean;
  processed: boolean;
  error: string | null;
  createdAt: string;
}

interface WebhookLogResponse {
  events: WebhookEvent[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  filters: { platforms: string[]; eventTypes: string[] };
}

export default function MetaAppIntegrationPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [credentialId, setCredentialId] = useState<number | null>(null);
  const [configured, setConfigured] = useState(false);
  const [appSecretConfigured, setAppSecretConfigured] = useState(false);
  const [webhookTokenConfigured, setWebhookTokenConfigured] = useState(false);
  const [instagramSecretConfigured, setInstagramSecretConfigured] = useState(false);

  // Form state
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [instagramAppId, setInstagramAppId] = useState("");
  const [instagramAppSecret, setInstagramAppSecret] = useState("");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const [configId, setConfigId] = useState("");
  const [apiVersion, setApiVersion] = useState("v25.0");
  const [appReviewPermissions, setAppReviewPermissions] = useState<Record<MetaReviewPermission, MetaReviewStatus>>(DEFAULT_REVIEW_STATUS);

  // Connections & stats
  const [connections, setConnections] = useState<MetaConnection[]>([]);
  const [stats, setStats] = useState<MetaStats | null>(null);
  const [health, setHealth] = useState<MetaHealth | null>(null);

  // Webhook logs state
  const [webhookLogs, setWebhookLogs] = useState<WebhookEvent[]>([]);
  const [webhookPagination, setWebhookPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [webhookFilters, setWebhookFilters] = useState<{ platforms: string[]; eventTypes: string[] }>({ platforms: [], eventTypes: [] });
  const [filterPlatform, setFilterPlatform] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterEventType, setFilterEventType] = useState<string>("all");
  const [webhookLogsLoading, setWebhookLogsLoading] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<number | null>(null);

  const webhookUrl = typeof window !== "undefined"
    ? buildApiUrl("/api/webhooks/instagram")
    : "";


  const instagramCallbackUrl = typeof window !== "undefined"
    ? buildOAuthCallbackUrl("/api/instagram/oauth/callback")
    : "";

  const facebookCallbackUrl = typeof window !== "undefined"
    ? buildOAuthCallbackUrl("/api/facebook/oauth/callback")
    : "";

  const metaCallbackUrl = typeof window !== "undefined"
    ? buildOAuthCallbackUrl("/api/meta/oauth/callback")
    : "";

  const whatsappCallbackUrl = typeof window !== "undefined"
    ? buildOAuthCallbackUrl("/api/whatsapp/oauth/callback")
    : "";

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      // Editable metadata is returned, but stored secrets never leave the API.
      const data = await api.get<{ configured: boolean; config: MetaConfig | null }>(
        "/api/admin/meta/config/full"
      );
      setConfigured(data.configured);
      if (data.config) {
        setCredentialId(data.config.id || null);
        setAppId(data.config.appId || "");
        setAppSecret("");
        setWebhookVerifyToken("");
        setConfigId(data.config.configId || "");
        setInstagramAppSecret("");
        setAppSecretConfigured(data.config.appSecretConfigured === true);
        setWebhookTokenConfigured(data.config.webhookVerifyTokenConfigured === true);
        setInstagramSecretConfigured(data.config.instagramAppSecretConfigured === true);
        setInstagramAppId(data.config.instagramAppId || "");
        setApiVersion(data.config.apiVersion || "v25.0");
        setAppReviewPermissions({ ...DEFAULT_REVIEW_STATUS, ...(data.config.appReviewPermissions || {}) });
      }
    } catch {
      toast({ title: "Error", description: "Failed to load Meta configuration", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const fetchConnections = useCallback(async () => {
    try {
      const [connData, statsData, healthData] = await Promise.all([
        api.get<{ connections: MetaConnection[]; total: number }>("/api/admin/meta/connections"),
        api.get<{ stats: MetaStats }>("/api/admin/meta/stats"),
        api.get<{ health: MetaHealth }>("/api/admin/meta/health"),
      ]);
      setConnections(connData.connections || []);
      setStats(statsData.stats || null);
      setHealth(healthData.health || null);
    } catch {
      // Non-critical, don't show error
    }
  }, []);

  const fetchWebhookLogs = useCallback(async (page = 1) => {
    try {
      setWebhookLogsLoading(true);
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (filterPlatform !== "all") params.set("platform", filterPlatform);
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterEventType !== "all") params.set("eventType", filterEventType);

      const data = await api.get<WebhookLogResponse>(`/api/admin/meta/webhook-logs?${params.toString()}`);
      setWebhookLogs(data.events || []);
      setWebhookPagination(data.pagination || { page: 1, limit: 20, total: 0, totalPages: 0 });
      setWebhookFilters(data.filters || { platforms: [], eventTypes: [] });
    } catch {
      // Non-critical
    } finally {
      setWebhookLogsLoading(false);
    }
  }, [filterPlatform, filterStatus, filterEventType]);

  useEffect(() => {
    fetchConfig();
    fetchConnections();
    fetchWebhookLogs();
  }, [fetchConfig, fetchConnections, fetchWebhookLogs]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appId.trim() || (!configured && !appSecret.trim())) {
      toast({ title: "Error", description: configured ? "App ID is required" : "App ID and App Secret are required", variant: "destructive" });
      return;
    }
    try {
      setSaving(true);
      await api.post("/api/admin/meta/config", {
        appId: appId.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        ...(webhookVerifyToken.trim() ? { webhookVerifyToken: webhookVerifyToken.trim() } : {}),
        webhookUrl,
        configId: configId.trim() || undefined,
        apiVersion: apiVersion.trim() || "v25.0",
        instagramAppId: instagramAppId.trim() || undefined,
        instagramAppSecret: instagramAppSecret.trim() || undefined,
        appReviewPermissions,
      });
      toast({ title: "Success", description: "Meta App settings saved successfully" });
      setConfigured(true);
      setAppSecret("");
      setWebhookVerifyToken("");
      setInstagramAppSecret("");
      await fetchConfig();
      fetchConnections();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: (error as Error).message || "Failed to save settings",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!credentialId) return;
    try {
      setTesting(true);
      const data = await api.post<{ test?: { success: boolean; message?: string } }>(`/api/admin/integrations/${credentialId}/test`);
      toast({
        title: data.test?.success ? "Meta credentials are valid" : "Meta validation failed",
        description: data.test?.message || "The provider returned no validation details.",
        variant: data.test?.success ? undefined : "destructive",
      });
    } catch (error) {
      toast({ title: "Validation failed", description: error instanceof Error ? error.message : "Unable to validate Meta credentials", variant: "destructive" });
    } finally { setTesting(false); }
  };

  if (loading) {
    return (
      <LoadingState size="page" label="Loading Meta App settings…" />
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/dashboard/integrations">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 text-white">
              <Facebook className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter">Meta App</h1>
              <p className="text-muted-foreground">
                Global credentials for Facebook, Instagram, WhatsApp, and Ads
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => { fetchConfig(); fetchConnections(); fetchWebhookLogs(); }} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Status Badge */}
      {configured && (!instagramAppId || !instagramSecretConfigured) ? (
        <Callout tone="warning">
          The Meta App is configured, but Instagram Login cannot start until its separate Instagram App ID and secret are saved below. Facebook Page access also requires the applicable Meta permissions and app publication for ordinary customers.
        </Callout>
      ) : configured ? (
        <Callout tone="success" icon={Shield}>
          Meta App credentials are configured. Customer access depends on Meta app publication and permission approvals.
        </Callout>
      ) : (
        <Callout tone="warning" icon={Shield}>
          Meta App is not configured. Enter your Meta App credentials below to enable Facebook and Instagram integrations for all clients.
        </Callout>
      )}

      {/* Setup Guide */}
      <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-blue-600" />
            Setup Guide
          </CardTitle>
          <CardDescription>
            Complete these steps in the{" "}
            <a
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline inline-flex items-center gap-1"
            >
              Meta Developer Portal
              <ExternalLink className="h-3 w-3" />
            </a>{" "}
            before entering credentials below
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4 text-sm">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">1</span>
              <div>
                <p className="font-medium">Create a Meta App</p>
                <p className="text-muted-foreground mt-0.5">
                  Go to Meta Developer Portal → <strong>My Apps → Create App</strong> → select <strong>Business</strong> type → fill in App Name and Contact Email.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-medium">Add Required Products</p>
                <p className="text-muted-foreground mt-0.5">
                  In App Dashboard → <strong>Add Product</strong> → add: <strong>Messenger</strong>, <strong>Instagram Graph API</strong>, <strong>WhatsApp Business Platform</strong>, and <strong>Marketing API</strong>.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <p className="font-medium">Configure Basic Settings</p>
                <p className="text-muted-foreground mt-0.5">
                  <strong>Settings → Basic</strong> → set App Domains to <code className="text-xs bg-muted px-1 py-0.5 rounded">{deploymentHostname}</code> and add your Privacy Policy and Terms of Service URLs.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">4</span>
              <div>
                <p className="font-medium">Configure Webhooks</p>
                <p className="text-muted-foreground mt-0.5 mb-2">
                  Use the webhook URLs and verify token for all platforms. Go to <strong>App Dashboard → Webhooks</strong> (left sidebar) → <strong>Select product</strong> dropdown → choose the platform → <strong>Add Subscription</strong>.
                </p>
                <ul className="space-y-1.5 text-muted-foreground">
                  <li className="flex gap-2">
                    <Instagram className="h-3.5 w-3.5 text-pink-500 mt-0.5 shrink-0" />
                    <span>
                      <strong>Instagram:</strong> Select product → <strong>Instagram</strong> → Add Subscription → fields: <code className="text-xs bg-muted px-1 py-0.5 rounded">messages, messaging_postbacks, messaging_optins</code>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <Facebook className="h-3.5 w-3.5 text-blue-600 mt-0.5 shrink-0" />
                    <span>
                      <strong>Facebook / Messenger:</strong> Select product → <strong>Page</strong> → Add Subscription → fields: <code className="text-xs bg-muted px-1 py-0.5 rounded">messages, messaging_postbacks, feed</code>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <Webhook className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                    <span>
                      <strong>WhatsApp:</strong> Select product → <strong>Whatsapp Business Account</strong> → Add Subscription → fields: <code className="text-xs bg-muted px-1 py-0.5 rounded">messages</code>
                    </span>
                  </li>
                </ul>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">5</span>
              <div>
                <p className="font-medium">Add OAuth Redirect URIs</p>
                <p className="text-muted-foreground mt-0.5 mb-1.5">
                  Add each URL to its matching product&apos;s valid OAuth redirect URI settings:
                </p>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono break-all">{instagramCallbackUrl}</code>
                    <CopyButton value={instagramCallbackUrl} iconOnly label="Copy Instagram OAuth redirect URI" className="h-7 w-7 shrink-0" />
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono break-all">{facebookCallbackUrl}</code>
                    <CopyButton value={facebookCallbackUrl} iconOnly label="Copy Facebook OAuth redirect URI" className="h-7 w-7 shrink-0" />
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono break-all">{metaCallbackUrl}</code>
                    <CopyButton value={metaCallbackUrl} iconOnly label="Copy Meta OAuth redirect URI" className="h-7 w-7 shrink-0" />
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono break-all">{whatsappCallbackUrl}</code>
                    <CopyButton value={whatsappCallbackUrl} iconOnly label="Copy WhatsApp OAuth redirect URI" className="h-7 w-7 shrink-0" />
                  </div>
                </div>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">6</span>
              <div>
                <p className="font-medium">Enter Credentials Below</p>
                <p className="text-muted-foreground mt-0.5">
                   Copy your <strong>App ID</strong> and <strong>App Secret</strong> from Settings → Basic, then fill in the App Credentials form below and click <strong>Save Settings</strong>.
                </p>
              </div>
            </li>
          </ol>
        </CardContent>
      </Card>

      {/* Settings Form */}
      <Card>
        <CardHeader>
          <CardTitle>App Credentials</CardTitle>
          <CardDescription>
            Enter the Meta App ID and Secret from the{" "}
            <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
              Meta Developer Portal
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="appId">App ID</Label>
                <Input
                  id="appId"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="Enter Meta App ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="appSecret">App Secret</Label>
                <PasswordInput
                  id="appSecret"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={appSecretConfigured ? "Leave blank to keep the current secret" : "Enter Meta App Secret"}
                />
                {appSecretConfigured && <p className="text-xs text-muted-foreground">A secret is configured. Enter a new value only to rotate it.</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="webhookVerifyToken">Webhook Verify Token</Label>
                <PasswordInput
                  id="webhookVerifyToken"
                  value={webhookVerifyToken}
                  onChange={(e) => setWebhookVerifyToken(e.target.value)}
                  placeholder={webhookTokenConfigured ? "Leave blank to keep the current token" : "Custom verify token for webhooks"}
                />
                <p className="text-xs text-muted-foreground">
                  Set this same token in your Meta App webhook configuration
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="apiVersion">Graph API Version</Label>
                <Input
                  id="apiVersion"
                  value={apiVersion}
                  onChange={(e) => setApiVersion(e.target.value)}
                  placeholder="v25.0"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="configId">WhatsApp Embedded Signup Configuration ID</Label>
              <Input
                id="configId"
                value={configId}
                onChange={(e) => setConfigId(e.target.value)}
                inputMode="numeric"
                placeholder="Meta Facebook Login for Business configuration ID"
              />
              <p className="text-xs text-muted-foreground">
                Required for tenant WhatsApp onboarding. The selected Meta configuration must use the WhatsApp Embedded Signup variation.
              </p>
            </div>

            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">Instagram Login app (shared by all customers)</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="instagramAppId">Instagram App ID</Label>
                  <Input
                    id="instagramAppId"
                    value={instagramAppId}
                    onChange={(e) => setInstagramAppId(e.target.value)}
                    placeholder="Enter Instagram App ID"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="instagramAppSecret">Instagram App Secret</Label>
                  <PasswordInput
                    id="instagramAppSecret"
                    value={instagramAppSecret}
                    onChange={(e) => setInstagramAppSecret(e.target.value)}
                    placeholder={instagramSecretConfigured ? "Leave blank to keep the current secret" : "Enter Instagram App Secret"}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use the Instagram App ID and secret from Instagram API setup with Instagram login. Customers sign in with Instagram; they do not supply these credentials or link a Facebook Page.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t pt-4 space-y-3">
              <div>
                <p className="text-sm font-medium">Meta App Review capability status</p>
                <p className="text-xs text-muted-foreground">Administrative evidence only. Token consent is verified separately after each connection.</p>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {META_REVIEW_PERMISSIONS.map((permission) => (
                  <div key={permission} className="flex items-center justify-between gap-3 rounded-md border p-2">
                    <code className="min-w-0 truncate text-xs">{permission}</code>
                    <Select value={appReviewPermissions[permission]} onValueChange={(value: MetaReviewStatus) => setAppReviewPermissions((current) => ({ ...current, [permission]: value }))}>
                      <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="testing">Ready for testing</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                        <SelectItem value="not_requested">Not requested</SelectItem>
                        <SelectItem value="not_required">Not required</SelectItem>
                        <SelectItem value="unknown">Unknown</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

            </div>

            <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
              {credentialId && <Button type="button" variant="outline" onClick={() => void handleTest()} loading={testing} loadingText="Validating…">
                <Play className="h-4 w-4" />
                Validate saved credentials
              </Button>}
              <Button type="submit" loading={saving} loadingText="Saving…">
                <Save className="h-4 w-4" />
                {configured ? "Update Settings" : "Save Settings"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Stats */}
      <StatGrid columns={4} className="gap-4">
        <StatCard label="Total Connections" value={stats?.totalConnections ?? connections.length} icon={<Users className="text-blue-600" />} />
        <StatCard label="With Instagram" value={stats?.withInstagram ?? 0} icon={<Instagram className="text-pink-600" />} />
        <StatCard label="With Ads" value={stats?.withAds ?? 0} icon={<BarChart3 className="text-green-600" />} />
        <StatCard label="Webhook Events (24h)" value={health?.webhooks.totalEvents ?? 0} icon={<Webhook className="text-purple-600" />} />
      </StatGrid>

      {/* Integration Health */}
      {health && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Integration Health
              <Badge
                variant={health.overallStatus === 'healthy' ? 'default' : health.overallStatus === 'warning' ? 'secondary' : 'destructive'}
                className={health.overallStatus === 'healthy' ? 'bg-green-600' : ''}
              >
                {health.overallStatus === 'healthy' && <CheckCircle className="h-3 w-3 mr-1" />}
                {health.overallStatus === 'warning' && <AlertTriangle className="h-3 w-3 mr-1" />}
                {health.overallStatus === 'critical' && <XCircle className="h-3 w-3 mr-1" />}
                {health.overallStatus.charAt(0).toUpperCase() + health.overallStatus.slice(1)}
              </Badge>
            </CardTitle>
            <CardDescription>Token status, webhook activity, and recent errors</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Token Health */}
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Shield className="h-4 w-4" /> Token Status
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                <div className="text-center p-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                  <p className="text-lg font-bold text-green-600">{health.tokens.valid}</p>
                  <p className="text-xs text-muted-foreground">Valid</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
                  <p className="text-lg font-bold text-yellow-600">{health.tokens.expiring}</p>
                  <p className="text-xs text-muted-foreground">Expiring</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                  <p className="text-lg font-bold text-red-600">{health.tokens.expired}</p>
                  <p className="text-xs text-muted-foreground">Expired</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-gray-50 dark:bg-gray-900/20 border border-gray-200 dark:border-gray-700">
                  <p className="text-lg font-bold text-muted-foreground">{health.tokens.unknown}</p>
                  <p className="text-xs text-muted-foreground">Unknown</p>
                </div>
              </div>
              {health.tokens.details.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Show token details ({health.tokens.total} tokens)
                  </summary>
                  <div className="mt-2 space-y-2">
                    {health.tokens.details.map((t) => (
                      <div key={t.id} className="flex items-center justify-between p-2 rounded border text-xs">
                        <div className="flex items-center gap-2">
                          {t.status === 'valid' && <CheckCircle className="h-3.5 w-3.5 text-green-600" />}
                          {t.status === 'expiring' && <AlertTriangle className="h-3.5 w-3.5 text-yellow-600" />}
                          {t.status === 'expired' && <XCircle className="h-3.5 w-3.5 text-red-600" />}
                          {t.status === 'unknown' && <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                          <span className="font-medium">{t.platform}</span>
                          {t.account && <span className="text-muted-foreground">({t.account})</span>}
                          <span className="text-muted-foreground">User #{t.userId}</span>
                        </div>
                        <div>
                          {t.expiresAt ? (
                            <span className={t.status === 'expired' ? 'text-red-600' : t.status === 'expiring' ? 'text-yellow-600' : 'text-muted-foreground'}>
                              {new Date(t.expiresAt).toLocaleDateString()}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">No expiry</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>

            {/* Webhook Activity Summary */}
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Webhook className="h-4 w-4" /> Webhook Activity (Last 24h)
              </h4>
              {health.webhooks.last24h.length > 0 ? (
                <div className="space-y-2">
                  {health.webhooks.last24h.map((w) => (
                    <div key={w.platform} className="flex items-center justify-between p-2 rounded border text-sm">
                      <div className="flex items-center gap-2">
                        {w.platform === 'instagram' && <Instagram className="h-4 w-4 text-pink-500" />}
                        {w.platform === 'facebook' && <Facebook className="h-4 w-4 text-blue-600" />}
                        {!['instagram', 'facebook'].includes(w.platform) && <Webhook className="h-4 w-4" />}
                        <span className="font-medium capitalize">{w.platform}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span>{w.total} events</span>
                        <span className="text-green-600">{w.processed} processed</span>
                        {w.errors > 0 && <span className="text-red-600">{w.errors} errors</span>}
                        {w.signatureRejected > 0 && <span className="text-orange-600">{w.signatureRejected} rejected</span>}
                        {w.lastEvent && (
                          <span className="text-muted-foreground">
                            Last: {new Date(w.lastEvent).toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-2 border-t text-sm">
                    <span className="font-medium">Total</span>
                    <div className="flex items-center gap-3 text-xs">
                      <span>{health.webhooks.totalEvents} events</span>
                      {health.webhooks.totalErrors > 0 && <span className="text-red-600">{health.webhooks.totalErrors} errors</span>}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No webhook events in the last 24 hours</p>
              )}
            </div>

            {/* Recent Errors */}
            {health.recentErrors.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Recent Errors
                </h4>
                <div className="space-y-1">
                  {health.recentErrors.map((e) => (
                    <div key={e.id} className="flex items-start gap-2 p-2 rounded border border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10 text-xs">
                      <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium capitalize">{e.platform}</span>
                        {e.eventType && <span className="text-muted-foreground"> &middot; {e.eventType}</span>}
                        <span className="text-muted-foreground"> &middot; {new Date(e.createdAt).toLocaleString()}</span>
                        <p className="text-red-600 dark:text-red-400 mt-0.5">{e.error}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Webhook Event Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Webhook Event Logs
            {webhookPagination.total > 0 && (
              <Badge variant="secondary" className="ml-1">{webhookPagination.total} total</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Detailed log of all webhook events received from Meta platforms
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            <Select value={filterPlatform} onValueChange={(v) => setFilterPlatform(v)}>
              <SelectTrigger className="w-[160px] h-8 text-sm">
                <SelectValue placeholder="All Platforms" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Platforms</SelectItem>
                {webhookFilters.platforms.map((p) => (
                  <SelectItem key={p} value={p}>
                    <span className="capitalize">{p}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterEventType} onValueChange={(v) => setFilterEventType(v)}>
              <SelectTrigger className="w-[180px] h-8 text-sm">
                <SelectValue placeholder="All Event Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Event Types</SelectItem>
                {webhookFilters.eventTypes.map((et) => (
                  <SelectItem key={et} value={et!}>
                    {et}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v)}>
              <SelectTrigger className="w-[140px] h-8 text-sm">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="processed">Processed</SelectItem>
                <SelectItem value="error">Errors</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => fetchWebhookLogs(1)}
              loading={webhookLogsLoading}
              loadingText={null}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Event List */}
          {webhookLogsLoading && webhookLogs.length === 0 ? (
            <LoadingState size="section" label="Loading webhook events…" />
          ) : webhookLogs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Webhook className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No webhook events found</p>
              <p className="text-xs mt-1">Events will appear here as webhooks are received from Meta</p>
            </div>
          ) : (
            <div className="space-y-2">
              {webhookLogs.map((event) => (
                <div key={event.id} className="rounded-lg border overflow-hidden">
                  <button
                    className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors text-left"
                    onClick={() => setExpandedEventId(expandedEventId === event.id ? null : event.id)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="shrink-0">
                        {event.platform === 'instagram' && <Instagram className="h-4 w-4 text-pink-500" />}
                        {event.platform === 'facebook' && <Facebook className="h-4 w-4 text-blue-600" />}
                        {!['instagram', 'facebook'].includes(event.platform) && <Webhook className="h-4 w-4 text-muted-foreground" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium capitalize">{event.platform}</span>
                          {event.eventType && (
                            <Badge variant="outline" className="text-xs font-normal">{event.eventType}</Badge>
                          )}
                          {event.pageId && (
                            <span className="text-xs text-muted-foreground truncate">Page: {event.pageId}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {new Date(event.createdAt).toLocaleString()}
                          {event.userId && <span> &middot; User #{event.userId}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {event.error ? (
                        <Badge variant="destructive" className="text-xs">Error</Badge>
                      ) : event.processed ? (
                        <Badge className="text-xs bg-green-600">Processed</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Pending</Badge>
                      )}
                      {!event.signatureValid && (
                        <Badge variant="destructive" className="text-xs">Invalid Sig</Badge>
                      )}
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </button>
                  {expandedEventId === event.id && (
                    <div className="border-t bg-muted/30 p-3 space-y-2">
                      {event.error && (
                        <div className="text-xs">
                          <span className="font-medium text-red-600">Error: </span>
                          <span className="text-red-500">{event.error}</span>
                        </div>
                      )}
                      <div className="text-xs">
                        <span className="font-medium mb-1 block">Payload:</span>
                        <pre className="bg-muted p-2 rounded text-xs overflow-x-auto max-h-64 overflow-y-auto">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {webhookPagination.totalPages > 1 && (
            <Pagination
              className="pt-2 border-t"
              page={webhookPagination.page}
              pageSize={webhookPagination.limit}
              totalItems={webhookPagination.total}
              onPageChange={(page) => void fetchWebhookLogs(page)}
              itemLabel="events"
              disabled={webhookLogsLoading}
              aria-label="Webhook event log pages"
            />
          )}
        </CardContent>
      </Card>

      {/* Connected Users */}
      {connections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Connected Users ({connections.length})
            </CardTitle>
            <CardDescription>
              Users who have connected their Facebook/Instagram accounts via OAuth
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
                      <Facebook className="h-4 w-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-medium">
                        {conn.pageName || `Page ${conn.pageId}`}
                      </p>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>User #{conn.userId}</span>
                        {conn.instagramUsername && (
                          <>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <Instagram className="h-3 w-3" />
                              @{conn.instagramUsername}
                            </span>
                          </>
                        )}
                        {conn.adAccountName && (
                          <>
                            <span>•</span>
                            <span>Ad: {conn.adAccountName}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {conn.webhookSubscribed && (
                      <Badge variant="secondary" className="text-xs">
                        <Webhook className="h-3 w-3 mr-1" />
                        Webhook
                      </Badge>
                    )}
                    <Badge variant={conn.isActive ? "default" : "secondary"}>
                      {conn.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
