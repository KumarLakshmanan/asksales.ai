"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Webhook, FileText, Terminal, Power, PowerOff } from "lucide-react";
import { cn } from "@/lib/utils";
import api from "@/lib/api";
import { useIntegrationStatus } from "@/hooks/use-integration-status";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { WhatsAppConnectionGuide } from "@/components/integrations/ConnectionGuide";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
import { whatsappState } from "@/lib/integrations";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { SimpleStatusHeader } from "@/components/integrations/StatusHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { WhatsAppConnectionSummary } from "./components/WhatsAppConnectionSummary";
import { WhatsAppBillingCard } from "./components/WhatsAppBillingCard";
import { providerDeveloperToolsEnabled } from "@/lib/feature-flags";

const WhatsAppConnection = dynamic(() => import("./components/WhatsAppConnection").then(module => module.WhatsAppConnection));

interface WhatsAppStatus {
  success: boolean;
  configured: boolean;
  enabled?: boolean;
  config: {
    phoneNumberId?: string;
    businessAccountId?: string;
    apiVersion?: string;
    hasAccessToken?: boolean;
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
  } | null;
}

export default function WhatsAppIntegrationPage() {
  const { toast } = useToast();
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const status = useIntegrationStatus<WhatsAppStatus>("/api/whatsapp/config");
  const configured = status.data?.configured ?? false;
  const config = status.data?.config ?? null;
  const enabled = status.data?.enabled !== false;
  const loading = status.isPending;
  const loadError = status.error?.message ?? null;
  const { refetch } = status;
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
  }, [refetch]);
  const loadAll = () => refetch();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("error");
    const connected = params.get("whatsapp_connected") === "true";
    if (!oauthError && !connected) return;

    toast(connected
      ? {
          title: "WhatsApp connected",
          description: "Meta authorized the selected WhatsApp Business phone number.",
        }
      : {
          title: "WhatsApp connection failed",
          description: oauthError || "Meta could not complete the WhatsApp connection.",
          variant: "destructive",
        });

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("error");
    cleanUrl.searchParams.delete("whatsapp_connected");
    cleanUrl.searchParams.delete("whatsapp_limited");
    window.history.replaceState(window.history.state, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  }, [toast]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const { url } = await api.get<{ url: string }>("/api/whatsapp/oauth/url");
      if (!url) throw new Error("Sign-in could not be started. Please try again.");
      window.location.assign(url);
    } catch (error) {
      toast({ title: "Unable to connect WhatsApp", description: error instanceof Error ? error.message : "Try again or contact support.", variant: "destructive" });
      setConnecting(false);
    }
  };

  const handleTestConnection = async () => {
    try {
      setTesting(true);
      const res = await api.post<{ success: boolean; error?: string }>(
        "/api/whatsapp/test"
      );
      if (res.success) {
        await loadStatus();
        toast({
          title: "Test Successful",
          description: "WhatsApp Cloud API connection is working.",
        });
      } else {
        throw new Error(res.error || "Connection test failed");
      }
    } catch (error: unknown) {
      await loadStatus().catch(() => undefined);
      const message =
        error instanceof Error ? error.message : "An unknown error occurred";
      toast({
        title: "Test Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setTesting(false);
    }
  };

  const confirmDisconnect = async () => {
    try {
      await api.delete<{ success: boolean }>("/api/whatsapp/config");
      toast({
        title: "Disconnected",
        description: "WhatsApp has been disconnected.",
      });
      await loadAll();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to disconnect";
      toast({
        title: "Disconnect Error",
        description: message,
        variant: "destructive",
      });
    }
  };

  const handleToggleEnabled = async () => {
    const newState = !enabled;
    try {
      await api.post<{ success: boolean }>("/api/whatsapp/toggle", { enabled: newState });
      await loadStatus();
      toast({
        title: newState ? "WhatsApp Enabled" : "WhatsApp Disabled",
        description: newState ? "WhatsApp messaging is now active." : "WhatsApp messaging has been paused.",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to toggle";
      toast({ title: "Toggle Failed", description: message, variant: "destructive" });
    }
  };

  return (
    <IntegrationPageLayout
      icon={MessageSquare}
      iconBgClass="bg-[#25D366]"
      iconShadowClass="shadow-[#25D366]/20"
      name="WhatsApp"
      subtitle="Official WhatsApp Cloud API setup"
      loading={loading}
      loadingIcon={Terminal}
      loadingIconColor="text-[#25D366]"
      loadingMessage="Loading WhatsApp connection…"
      statusHeader={
        <div className="flex items-center gap-3">
          <SimpleStatusHeader
            connected={configured && (config?.connectionStatus === 'ready' || config?.connectionStatus === 'limited')}
            label="Meta Cloud API"
            detail={config?.phoneNumberId || null}
            connectedLabel="Connected"
            disconnectedLabel={configured
              ? config?.connectionStatus === 'reauth_required'
                ? "Reconnect required"
                : "Action required"
              : "Not linked"}
          />
          {configured && (
            <button
              onClick={handleToggleEnabled}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest transition-colors",
                enabled
                  ? "bg-[#25D366]/10 text-[#25D366] border-[#25D366]/20 hover:bg-[#25D366]/20"
                  : "bg-muted/20 text-muted-foreground border-border/40 hover:bg-muted/30"
              )}
            >
              {enabled ? <Power className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
              {enabled ? "Active" : "Paused"}
            </button>
          )}
        </div>
      }
      actions={
        <>
          <Link href="/dashboard/integrations/whatsapp/events">
            <Button
              variant="outline"
              className="h-10 px-4 rounded-xl font-semibold text-xs gap-2 border-border/40 hover:bg-muted/50 transition-all"
            >
              <Webhook className="w-3.5 h-3.5 text-[#25D366]" />
              Events
            </Button>
          </Link>
          <ConnectionGuideDrawer title="Connect WhatsApp" description="Choose your number situation and follow the matching Meta signup steps.">
            {close => <WhatsAppConnectionGuide onConnect={() => { close(); void handleConnect(); }} connecting={connecting} />}
          </ConnectionGuideDrawer>
        </>
      }
      fullWidth={<><IntegrationWorkspace
        provider="whatsapp"
        state={loadError ? "unavailable" : whatsappState({ configured, enabled, config })}
        accountName={config?.verifiedName || config?.wabaName || config?.displayPhoneNumber}
        accountSubtitle={config?.displayPhoneNumber}
        accountDetails={config?.phoneNumberId ? [{ label: "Phone number ID", value: config.phoneNumberId }, ...(config.businessAccountId ? [{ label: "Business account", value: config.businessAccountId }] : [])] : []}
        message={loadError || (config?.connectionStatus === "reauth_required" ? "Your WhatsApp authorization needs to be renewed. Reconnect through Meta to continue." : configured && config?.connectionStatus === "action_required" ? "Your account needs attention. Check the connection health in this card." : configured && !enabled ? "WhatsApp messaging is paused. Resume it when you are ready." : config?.connectionStatus === "limited" ? "Connected for the available messaging features. Check connection health for any remaining limits." : undefined)}
        onConnect={handleConnect}
        connecting={connecting}
        onRetry={loadAll}
        onDisconnect={() => setShowDisconnectDialog(true)}
        primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/outreach/inbox">Open Inbox</Link></Button>}
        secondaryActions={configured && <Button variant="outline" className="rounded-full" onClick={handleToggleEnabled}>{enabled ? "Pause messaging" : "Resume messaging"}</Button>}
        settings={<>
          {loadError && <Alert variant="destructive"><AlertTitle>WhatsApp status could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void loadAll()}>Try again</Button></AlertDescription></Alert>}
          {!loadError && configured && config && <WhatsAppConnectionSummary status={config} onTest={handleTestConnection} testing={testing} />}
          {!loadError && configured && <WhatsAppBillingCard phoneNumberId={config?.phoneNumberId} />}
          {providerDeveloperToolsEnabled && <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Developer credentials</summary><div className="mt-4"><WhatsAppConnection
            showConnectionActions={false}
            configured={configured}
            settings={config}
            onTest={handleTestConnection}
            onDisconnect={async () => setShowDisconnectDialog(true)}
            testing={testing}
          /></div></details>}

          <Link href="/dashboard/integrations/whatsapp/templates" className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] focus-visible:ring-offset-2">
            <div className="flex min-h-20 items-center gap-4 rounded-xl border border-[#25D366]/40 bg-[#25D366]/10 p-4 transition-colors group-hover:bg-[#25D366]/15">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#25D366] text-white shadow-sm">
                <FileText className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Message Templates</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Create and manage local drafts{configured ? ", then check Meta approval status." : ". Connect WhatsApp when you are ready to sync with Meta."}</p>
              </div>
              <span aria-hidden="true" className="text-lg text-[#25D366] transition-transform group-hover:translate-x-0.5">→</span>
            </div>
          </Link>
        </>}
      /></>}
      disconnectDialog={
        <AlertDialog
          open={showDisconnectDialog}
          onOpenChange={setShowDisconnectDialog}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect WhatsApp?</AlertDialogTitle>
              <AlertDialogDescription>
                You will need to reconnect to send and receive WhatsApp
                messages.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDisconnect}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}
