"use client";

import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { InstagramConnectionGuide } from "@/components/integrations/ChannelConnectionGuides";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
import { ChannelAccountSelector } from "@/components/integrations/ChannelAccountSelector";
import { messagingState, messagingNextStep } from "@/lib/integrations";
import { selectedBusinessProfileId } from '@/lib/business-profile';

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Instagram, Webhook, Terminal, Workflow } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
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
import { Button } from "@/components/ui/button";
import Link from "next/link";
import dynamic from "next/dynamic";
import api from "@/lib/api";
import { useIntegrationStatus } from "@/hooks/use-integration-status";

// Shared components
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { SimpleStatusHeader } from "@/components/integrations/StatusHeader";

// Modular Components
import { InstagramOAuthStatus } from "./components/types";
import { MetaMessagingConnectionDetails } from "@/components/integrations/MetaMessagingConnectionDetails";
import { providerDeveloperToolsEnabled } from "@/lib/feature-flags";
import { InstagramConnectionHealth } from "@/components/instagram-automations/InstagramConnectionHealth";

const InstagramOfficialAPI = dynamic(() => import("./components/InstagramOfficialAPI").then(module => module.InstagramOfficialAPI));

export default function InstagramIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const status = useIntegrationStatus<InstagramOAuthStatus>("/api/instagram/oauth/status");
  const oauthStatus = status.data ?? null;
  const loading = status.isPending;
  const statusLoadError = status.error?.message ?? null;
  const { refetch } = status;

  // Loading/Action States
  const [refreshingToken, setRefreshingToken] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
  }, [refetch]);
  const loadAllSetup = () => refetch();

  useEffect(() => {
    const error = searchParams.get("error");
    const connected = searchParams.get("connected") || searchParams.get("instagram_api_connected");
    if (error) {
      toast({ title: "Instagram Connection Error", description: error, variant: "destructive" });
      router.replace("/dashboard/integrations/instagram");
    } else if (connected) {
      toast({ title: "Instagram authorization received", description: "Choose your account and review its connection below." });
      router.replace("/dashboard/integrations/instagram");
      void refetch();
    }
  }, [refetch, router, searchParams, toast]);

  const handleOAuthConnect = async (feature?: string) => {
    try {
      setConnecting(true);
      const query = new URLSearchParams({ format: "json", businessProfileId: String(selectedBusinessProfileId()) });
      if (feature) query.set("feature", feature);
      const result = await api.get<{ url: string }>(`/api/instagram/oauth/authorize?${query}`);
      if (!result.url) throw new Error("Sign-in could not be started. Please try again.");
      window.location.assign(result.url);
    } catch (error) {
      toast({ title: "Unable to connect", description: error instanceof Error ? error.message : "Try again or contact support.", variant: "destructive" });
      setConnecting(false);
    }
  };

  const handleRefreshToken = async () => {
    try {
      setRefreshingToken(true);
      await api.post("/api/instagram/oauth/refresh");
      toast({ title: "Connection Refreshed" });
      await loadStatus();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Refresh failed";
      toast({ title: "Refresh Error", description: message, variant: "destructive" });
    } finally {
      setRefreshingToken(false);
    }
  };

  const handleDisconnect = async () => setShowDisconnectDialog(true);

  const confirmDisconnect = async () => {
    setShowDisconnectDialog(false);
    try {
      await api.post("/api/instagram/oauth/disconnect", { type: "api" });
      toast({ title: "Disconnected", description: "Instagram API connection has been removed." });
      await loadStatus();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to disconnect";
      toast({ title: "Disconnect Error", description: message, variant: "destructive" });
    }
  };

  const isApiConnected = oauthStatus?.officialApi.connected ?? false;
  const apiUsername = oauthStatus?.officialApi.username ?? null;

  return (
    <IntegrationPageLayout
      icon={Instagram}
      iconBgClass="bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]"
      iconShadowClass="shadow-[#dc2743]/20"
      name="Instagram"
      subtitle="Connect your professional account and manage Instagram messaging."
      loading={loading}
      loadingIcon={Terminal}
      loadingIconColor="text-[#dc2743]"
      loadingMessage="Loading Instagram connection…"
      statusHeader={
        <SimpleStatusHeader
          connected={isApiConnected}
          label={isApiConnected ? "API connected" : "API not connected"}
          detail={apiUsername}
        />
      }
      actions={
        <>
          <Button asChild variant="outline" className="h-10 gap-2 rounded-xl px-4 text-xs font-semibold">
            <Link href="/dashboard/integrations/instagram/automations"><Workflow className="h-3.5 w-3.5" />Automations</Link>
          </Button>
          <Link href="/dashboard/integrations/instagram/events">
            <Button
              variant="outline"
              className="h-10 px-4 rounded-xl font-semibold text-xs gap-2 border-border/40 hover:bg-muted/50 transition-all"
            >
              <Webhook className="w-3.5 h-3.5 text-[#dc2743]" /> Events
            </Button>
          </Link>
          <ConnectionGuideDrawer title="Connect Instagram" description="Follow the Instagram sign-in steps, then return to this page to check your account.">
            {close => <InstagramConnectionGuide onConnect={() => { close(); void handleOAuthConnect(); }} connecting={connecting} />}
          </ConnectionGuideDrawer>
        </>
      }
      fullWidth={<><IntegrationWorkspace
        provider="instagram"
        state={messagingState(oauthStatus?.officialApi, statusLoadError)}
        accountName={oauthStatus?.officialApi.username}
        accountImage={oauthStatus?.officialApi.profilePicture}
        accountSubtitle={oauthStatus?.officialApi.username ? `@${oauthStatus.officialApi.username.replace(/^@/, "")}` : null}
        accountDetails={[
          ...(oauthStatus?.officialApi.pageName ? [{ label: "Linked Facebook Page", value: oauthStatus.officialApi.pageName }] : []),
          ...(oauthStatus?.officialApi.followersCount != null ? [{ label: "Followers", value: oauthStatus.officialApi.followersCount.toLocaleString() }] : []),
          ...(oauthStatus?.officialApi.instagramAccountId ? [{ label: "Account ID", value: oauthStatus.officialApi.instagramAccountId }] : []),
        ]}
        message={statusLoadError || (oauthStatus?.officialApi.loginConfigured === false && !oauthStatus.officialApi.connected ? "Instagram sign-in is temporarily unavailable while the app administrator completes the Instagram Login setup." : messagingNextStep(oauthStatus?.officialApi, "instagram"))}
        reconnectLabel="Reconnect with Instagram"
        onConnect={() => void handleOAuthConnect()}
        connectDisabled={oauthStatus?.officialApi.loginConfigured === false}
        onAuthorizeFeature={scope => void handleOAuthConnect(scope)}
        connecting={connecting}
        onDisconnect={handleDisconnect}
        onRetry={loadAllSetup}
        capabilities={oauthStatus?.officialApi.capabilities}
        primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/outreach/inbox">Open Inbox</Link></Button>}
        selection={oauthStatus?.officialApi.credentialId ? <ChannelAccountSelector variant={oauthStatus.officialApi.selectionRequired ? "card" : "button"} key={oauthStatus?.officialApi.credentialId || "accounts"} platform="instagram_api" label="Instagram account" onChanged={loadStatus} /> : null}
        settings={oauthStatus?.officialApi.authorized || providerDeveloperToolsEnabled ? <>
          {oauthStatus?.officialApi.authorized && <MetaMessagingConnectionDetails account={oauthStatus.officialApi} refreshing={refreshingToken} onRefresh={handleRefreshToken} />}
          {oauthStatus?.officialApi.authorized && <InstagramConnectionHealth account={oauthStatus.officialApi} />}
          {providerDeveloperToolsEnabled && <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Developer credentials</summary><div className="mt-4"><InstagramOfficialAPI
            showConnectionActions={false}
            oauthStatus={oauthStatus}
            refreshingToken={refreshingToken}
            onOAuthConnect={() => void handleOAuthConnect()}
            onRefreshToken={handleRefreshToken}
            onAccountChanged={loadStatus}
            onDisconnect={handleDisconnect}
          /></div></details>}
        </> : null}
      /></>}
      disconnectDialog={
        <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect Instagram API?</AlertDialogTitle>
              <AlertDialogDescription>
                Instagram messaging and publishing will stop until you reconnect. Your Facebook Page and Meta Ads connections stay connected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDisconnect} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}
