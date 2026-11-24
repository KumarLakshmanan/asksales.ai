"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ShieldCheck,
  Link2,
  Phone,
  Layers,
  Database,
  Building2,
  CheckCircle2,
  XCircle,
  LogOut,
  RefreshCw,
  Smartphone,
  Eye,
  EyeOff,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { providerDeveloperToolsEnabled } from "@/lib/feature-flags";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface WhatsAppConfig {
  phoneNumberId?: string;
  businessAccountId?: string;
  apiVersion?: string;
  hasAccessToken?: boolean;
  lastUsedAt?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  wabaName?: string;
  accessTokenExpiresAt?: string | null;
  tokenStatus?: 'active' | 'expiring_soon' | 'expired' | 'invalid' | 'unknown';
  connectionStatus?: 'ready' | 'limited' | 'action_required' | 'reauth_required';
  readinessErrorCode?: string | null;
  readiness?: { sending: boolean; customerReplies?: boolean; proactiveSending?: boolean; webhook: boolean; oauth: boolean };
  grantedScopes?: string[];
  lastVerifiedAt?: string | null;
}

interface WhatsAppConnectionProps {
  showConnectionActions?: boolean;
  configured: boolean;
  settings: WhatsAppConfig | null;
  onTest: () => Promise<void>;
  onDisconnect?: () => Promise<void>;
  testing: boolean;
}

export function WhatsAppConnection({
  showConnectionActions = true,
  configured,
  settings,
  onTest,
  onDisconnect,
  testing,
}: WhatsAppConnectionProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"oauth" | "manual">("oauth");
  const [saving, setSaving] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const connectionHealthy = configured && settings?.connectionStatus === 'ready';
  const replyReady = configured && settings?.connectionStatus === 'limited';
  const connectionUsable = connectionHealthy || replyReady;
  const requiresReconnect = settings?.connectionStatus === 'reauth_required';
  // Keep actionable provider failures available to the client, but suppress
  // Meta review/billing advisories that belong in administrator tooling.
  const readinessMessage = settings?.readinessErrorCode === 'WABA_HEALTH' || settings?.readinessErrorCode === 'APP_REVIEW'
    ? null
    : settings?.readinessErrorCode === 'meta_100_33'
    ? 'Meta no longer exposes the selected phone number to this WhatsApp Business Account. Check account restrictions, phone registration, payment status, and business verification in WhatsApp Manager. Reconnecting alone cannot restore a disabled account.'
    : settings?.readinessErrorCode
      ? 'Meta reports that this WhatsApp Business Account needs attention before messaging can resume. Run the connection test and resolve the reported provider issue.'
      : null;

  const [manualForm, setManualForm] = useState({
    appId: "",
    appSecret: "",
    accessToken: "",
    phoneNumberId: "",
    businessAccountId: "",
  });

  const handleManualSave = async () => {
    if (
      !manualForm.appId ||
      !manualForm.appSecret ||
      !manualForm.accessToken ||
      !manualForm.phoneNumberId ||
      !manualForm.businessAccountId
    ) {
      toast({
        title: "Missing fields",
        description: "Required fields are missing.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ success: boolean; error?: string }>(
        "/api/whatsapp/manual-credentials",
        manualForm
      );
      if (res.success) {
        toast({
          title: "Settings Saved",
          description: "Manual API settings have been updated.",
        });
        window.location.reload();
      } else {
        toast({
          title: "Save Failed",
          description: res.error || "Failed to save credentials",
          variant: "destructive",
        });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to save credentials";
      toast({ title: "Save Failed", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleOAuthConnect = async () => {
    try {
      const response = await api.get<{ url: string }>(
        "/api/whatsapp/oauth/url"
      );
      if (response.url) {
        window.location.href = response.url;
      }
    } catch (error: unknown) {
      toast({
        title: "Connection could not start",
        description: error instanceof Error ? error.message : "WhatsApp Embedded Signup is unavailable.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 overflow-hidden divide-y divide-border/40 w-full shadow-lg shadow-black/5">
      {/* Header Row with Segmented Control */}
      <div className="flex items-center justify-between p-2 bg-muted/10">
        <div className="flex items-center gap-2 px-2">
          <div className="w-6 h-6 rounded bg-[#25D366]/10 flex items-center justify-center text-[#25D366] border border-[#25D366]/20">
            <Link2 className="w-3 h-3" />
          </div>
          <span className="text-xs font-bold">WhatsApp API Connection</span>
        </div>

        {/* Segmented Control */}
        <div className="flex bg-background/50 p-0.5 rounded-lg border border-border/40">
          <button
            onClick={() => setMode("oauth")}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-black uppercase tracking-widest transition-all",
              mode === "oauth"
                ? "bg-[#25D366] text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            1-Click Auth
          </button>
          {providerDeveloperToolsEnabled && (
            <button
              onClick={() => setMode("manual")}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-black uppercase tracking-widest transition-all",
                mode === "manual"
                  ? "bg-[#25D366] text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Dev App
            </button>
          )}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {mode === "oauth" ? (
          <motion.div
            key="oauth"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="p-0"
          >
            <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors">
              <div className="flex items-center gap-3">
                {connectionUsable ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-muted-foreground/40" />
                )}
                <div>
                  <p className="text-xs font-bold">
                    Meta Graph API Status
                  </p>
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">
                    {connectionHealthy
                      ? "Connected"
                      : replyReady
                        ? "Connected"
                      : configured ? requiresReconnect ? "Reconnect Required" : "Action Required" : "Connection Required"}
                  </p>
                </div>
              </div>
              {!configured ? (showConnectionActions &&
                <Button
                  size="sm"
                  onClick={handleOAuthConnect}
                  className="h-7 text-xs px-3 font-black uppercase tracking-widest rounded-md bg-[#25D366] hover:bg-[#20bd5a] text-white shadow-sm transition-all active:scale-95"
                >
                  Connect
                </Button>
              ) : (
                <Badge
                  variant="default"
                  className="h-5 text-xs px-1.5 uppercase font-black tracking-widest bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20"
                >
                  {connectionUsable ? 'Connected' : requiresReconnect ? 'Reconnect' : 'Blocked'}
                </Badge>
              )}
            </div>

            {configured && readinessMessage && (
              <div className="border-t border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100">
                <p className="font-bold">WhatsApp provider action required</p>
                <p className="mt-1 leading-relaxed">{readinessMessage}</p>
                <a
                  href="https://business.facebook.com/latest/whatsapp_manager/phone_numbers/"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex font-semibold underline underline-offset-2"
                >
                  Open WhatsApp Manager
                </a>
              </div>
            )}

            {configured && settings && (
              <>
                {/* Profile Card */}
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border-t border-border/40 bg-[#25D366]/5 p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      <div className="w-11 h-11 rounded-xl bg-[#25D366]/15 border-2 border-[#25D366]/25 flex items-center justify-center">
                        <svg
                          viewBox="0 0 24 24"
                          className="w-6 h-6 fill-[#25D366]"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                        </svg>
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center">
                        <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold truncate leading-tight">
                        {settings.verifiedName ||
                          settings.displayPhoneNumber ||
                          "WhatsApp Business"}
                      </p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-medium mt-0.5">
                        {settings.displayPhoneNumber ||
                          `ID: ${settings.phoneNumberId}`}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-[#25D366]/10 text-[#25D366] border border-[#25D366]/20">
                          Business
                        </Badge>
                        {settings.verifiedName && (
                          <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                            <CheckCircle2 className="w-2 h-2 mr-1" />
                            Verified
                          </Badge>
                        )}
                        <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-muted/60 text-muted-foreground border border-border/40">
                          v{settings.apiVersion}
                        </Badge>
                      </div>
                    </div>
                    {showConnectionActions && <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted"
                        onClick={handleOAuthConnect}
                        title="Reconnect WhatsApp"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-rose-500 hover:bg-rose-500/10"
                        onClick={onDisconnect}
                        title="Disconnect WhatsApp"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                      </Button>
                    </div>}
                  </div>

                  {/* WABA Info */}
                  {settings.wabaName && (
                    <div className="mt-2.5 pt-2.5 border-t border-[#25D366]/15 flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-[#25D366]/10 border border-[#25D366]/15 flex items-center justify-center shrink-0">
                        <Building2 className="w-3.5 h-3.5 text-[#25D366]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold truncate">
                          {settings.wabaName}
                        </p>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest">
                          WhatsApp Business Account ·{" "}
                          {settings.businessAccountId}
                        </p>
                      </div>
                    </div>
                  )}
                </motion.div>

                <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors border-t border-border/40">
                  <div className="flex items-center gap-3">
                    <Phone className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <div>
                      <p className="text-xs font-bold">Phone Number ID</p>
                      <p className="text-xs font-mono text-muted-foreground uppercase tracking-tight">
                        {settings.phoneNumberId}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="secondary"
                    className="h-5 text-xs px-1.5 uppercase font-black tracking-widest bg-muted/40"
                  >
                    Active
                  </Badge>
                </div>

                <div className="flex items-center justify-between gap-3 p-3 hover:bg-muted/5 transition-colors border-t border-border/40">
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <div>
                      <p className="text-xs font-bold">Delivery readiness</p>
                      <p className="text-xs text-muted-foreground">
                        {settings.readiness?.sending && settings.readiness?.webhook
                          ? 'Sending and customer replies are ready.'
                          : settings.readiness?.customerReplies && settings.readiness?.webhook
                            ? 'Customer replies are ready.'
                          : settings.readiness?.webhook
                            ? 'The selected phone number needs attention before replies can arrive.'
                            : 'Incoming replies are not ready yet. Reconnect or contact support.'}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "h-5 text-xs px-1.5 uppercase font-black tracking-widest",
                      !connectionUsable
                        ? "bg-rose-500/10 text-rose-600"
                        : settings.tokenStatus === 'expiring_soon'
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-emerald-500/10 text-emerald-600"
                    )}
                  >
                    {settings.tokenStatus === 'expiring_soon'
                      ? 'Token expiring'
                      : requiresReconnect
                        ? 'Reconnect'
                        : replyReady
                          ? 'Connected'
                        : connectionHealthy
                          ? 'Ready'
                          : 'Blocked'}
                  </Badge>
                </div>

                <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors border-t border-border/40">
                  <div className="flex items-center gap-3">
                    <Database className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <div>
                      <p className="text-xs font-bold">
                        Business Account ID
                      </p>
                      <p className="text-xs font-mono text-muted-foreground uppercase tracking-tight">
                        {settings.businessAccountId}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors border-t border-border/40">
                  <div className="flex items-center gap-3">
                    <Layers className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <div>
                      <p className="text-xs font-bold">API Integration</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest">
                        Version {settings.apiVersion}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-black uppercase tracking-widest text-emerald-500">
                      Live
                    </span>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 p-3 border-t border-border/40 bg-emerald-500/5">
                  <Button
                    onClick={onTest}
                    loading={testing}
                    loadingText="Test Connection"
                    className="h-7 text-xs px-3 font-black uppercase tracking-widest rounded-md bg-emerald-500 hover:bg-emerald-600 text-white shadow-sm transition-all active:scale-95 gap-2"
                  >
                    <Smartphone className="w-3 h-3" />
                    Test Connection
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="manual"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="p-3 bg-muted/5 space-y-3"
          >
            <div>
              <p className="text-xs font-bold">Manual App Credentials</p>
              <p className="text-xs text-muted-foreground uppercase tracking-widest mt-0.5">
                Use your private Meta Developer Application
              </p>
            </div>

            {configured && (
              <p className="text-xs text-muted-foreground px-1">
                Already connected. Leave secret/token fields blank to keep
                existing credentials.
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">
                  Meta App ID
                </Label>
                <Input
                  value={manualForm.appId}
                  onChange={(e) =>
                    setManualForm({ ...manualForm, appId: e.target.value })
                  }
                  placeholder="Enter App ID"
                  className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">
                  App Secret
                </Label>
                <div className="relative">
                  <Input
                    type={showTokens ? "text" : "password"}
                    value={manualForm.appSecret}
                    onChange={(e) =>
                      setManualForm({
                        ...manualForm,
                        appSecret: e.target.value,
                      })
                    }
                    placeholder="••••••••••••••••"
                    className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                  />
                  <button
                    type="button"
                    aria-label={showTokens ? "Hide app secret" : "Show app secret"}
                    onClick={() => setShowTokens(!showTokens)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded-md"
                  >
                    {showTokens ? (
                      <EyeOff className="w-3 h-3 text-muted-foreground" />
                    ) : (
                      <Eye className="w-3 h-3 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5 col-span-1 md:col-span-2">
                <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">
                  System User Access Token
                </Label>
                <Input
                  type={showTokens ? "text" : "password"}
                  value={manualForm.accessToken}
                  onChange={(e) =>
                    setManualForm({
                      ...manualForm,
                      accessToken: e.target.value,
                    })
                  }
                  placeholder="EAAB..."
                  className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">
                  Phone Number ID
                </Label>
                <Input
                  value={manualForm.phoneNumberId}
                  onChange={(e) =>
                    setManualForm({
                      ...manualForm,
                      phoneNumberId: e.target.value,
                    })
                  }
                  placeholder="123..."
                  className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">
                  WABA ID
                </Label>
                <Input
                  value={manualForm.businessAccountId}
                  onChange={(e) =>
                    setManualForm({
                      ...manualForm,
                      businessAccountId: e.target.value,
                    })
                  }
                  placeholder="456..."
                  className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleManualSave}
                loading={saving}
                loadingText="Save Developer Config"
                className="h-8 px-6 rounded-md bg-[#25D366] hover:bg-[#20bd5a] text-white font-black text-xs uppercase tracking-widest shadow-sm active:scale-95 transition-all gap-2"
              >
                <Link2 className="w-3 h-3" />
                Save Developer Config
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2 p-2.5 bg-emerald-500/5 border-t border-border/40">
        <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest leading-relaxed">
          Official Meta Cloud API. End-to-end encryption maintained.
        </p>
      </div>
    </div>
  );
}
