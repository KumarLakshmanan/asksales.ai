"use client";

import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { FacebookConnectionGuide } from "@/components/integrations/ChannelConnectionGuides";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
import { ChannelAccountSelector } from "@/components/integrations/ChannelAccountSelector";
import { messagingState, messagingNextStep, type MetaMessagingStatus } from "@/lib/integrations";
import { selectedBusinessProfileId } from '@/lib/business-profile';

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Facebook, Webhook, Terminal } from "lucide-react";
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
import api from "@/lib/api";
import { useIntegrationStatus } from "@/hooks/use-integration-status";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { SimpleStatusHeader } from "@/components/integrations/StatusHeader";
import { MetaMessagingConnectionDetails } from "@/components/integrations/MetaMessagingConnectionDetails";
import { providerDeveloperToolsEnabled } from "@/lib/feature-flags";

const FacebookOfficialAPI = dynamic(() => import("./components/FacebookOfficialAPI").then(module => module.FacebookOfficialAPI));

type FacebookOAuthStatus = MetaMessagingStatus;

export default function FacebookIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const status = useIntegrationStatus<FacebookOAuthStatus>("/api/facebook/oauth/status");
  const oauthStatus = status.data ?? null;
  const loading = status.isPending;
  const oauthLoadError = status.error?.message ?? null;
  const { refetch } = status;
  const [refreshingToken, setRefreshingToken] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
  }, [refetch]);
  const loadAll = () => refetch();

  useEffect(() => {
    const error = searchParams.get("error");
    const authorized = searchParams.get("facebook_connected") || searchParams.get("connected");
    if (!error && !authorized) return;
    toast(error ? { title: "Facebook connection needs attention", description: error, variant: "destructive" } : { title: "Facebook authorization received", description: "Choose your Page and review its Messenger connection below." });
    router.replace("/dashboard/integrations/facebook");
    void refetch();
  }, [refetch, router, searchParams, toast]);

  const handleOAuthConnect = async (feature?: string) => {
    try {
      setConnecting(true);
      const query = new URLSearchParams({ format: "json", businessProfileId: String(selectedBusinessProfileId()) });
      if (feature) query.set("feature", feature);
      const result = await api.get<{ url: string }>(`/api/facebook/oauth/authorize?${query}`);
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
      await api.post("/api/facebook/oauth/refresh");
      toast({ title: "Token Refreshed", description: "Facebook access token updated." });
      await loadStatus();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to refresh connection";
      toast({ title: "Refresh Error", description: message, variant: "destructive" });
    } finally {
      setRefreshingToken(false);
    }
  };

  const handleDisconnect = async () => setShowDisconnectDialog(true);

  const confirmDisconnect = async () => {
    setShowDisconnectDialog(false);
    try {
      await api.post("/api/facebook/oauth/disconnect");
      toast({
        title: "Disconnected",
        description: "The Facebook API connection has been removed.",
      });
      await loadStatus();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to disconnect";
      toast({ title: "Disconnect Error", description: message, variant: "destructive" });
    }
  };

  const actions = (
    <>
      <Link href="/dashboard/integrations/facebook/events">
        <Button variant="outline" className="h-10 px-4 rounded-xl font-semibold text-xs gap-2 border-border/40 hover:bg-muted/50 transition-all">
          <Webhook className="w-3.5 h-3.5 text-blue-500" />
          Events
        </Button>
      </Link>
      <ConnectionGuideDrawer title="Connect a Facebook Page" description="Sign in with Facebook and choose the Page you manage.">
        {close => <FacebookConnectionGuide onConnect={() => { close(); void handleOAuthConnect(); }} connecting={connecting} />}
      </ConnectionGuideDrawer>
    </>
  );

  const statusHeader = (
    <SimpleStatusHeader
      connected={oauthStatus?.officialApi.connected || false}
      label={oauthStatus?.officialApi.connected ? "API connected" : "API not connected"}
      detail={oauthStatus?.officialApi.username || null}
    />
  );

  const connections = oauthStatus?.officialApi.authorized || providerDeveloperToolsEnabled ? (
    <>
      {oauthStatus?.officialApi.authorized && <MetaMessagingConnectionDetails account={oauthStatus.officialApi} refreshing={refreshingToken} onRefresh={handleRefreshToken} />}
      {providerDeveloperToolsEnabled && <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Developer credentials</summary><div className="mt-4"><FacebookOfficialAPI
        showConnectionActions={false}
        status={oauthStatus}
        refreshing={refreshingToken}
        onConnect={() => void handleOAuthConnect()}
        onRefresh={handleRefreshToken}
        onAccountChanged={loadStatus}
        onDisconnect={handleDisconnect}
      /></div></details>}
    </>
  ) : null;

  const disconnectDialog = (
    <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect Facebook API?</AlertDialogTitle>
          <AlertDialogDescription>
            Messenger and Facebook Page features will stop until you reconnect. Your Instagram and Meta Ads connections stay connected. Shared Page permissions removed at Meta may affect both messaging channels.
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
  );

  return (
    <IntegrationPageLayout
      icon={Facebook}
      iconBgClass="bg-blue-600"
      iconShadowClass="shadow-blue-600/20"
      name="Facebook"
      subtitle="Connect your Page and manage Messenger conversations."
      loading={loading}
      loadingMessage="Loading Facebook connection…"
      loadingIcon={Terminal}
      loadingIconColor="text-blue-600"
      statusHeader={statusHeader}
      actions={actions}
      fullWidth={<><IntegrationWorkspace
        provider="facebook"
        state={messagingState(oauthStatus?.officialApi, oauthLoadError)}
        accountName={oauthStatus?.officialApi.username}
        accountImage={oauthStatus?.officialApi.pagePictureUrl}
        accountSubtitle="Facebook Page · Messenger"
        accountDetails={oauthStatus?.officialApi.pageId ? [{ label: "Page ID", value: oauthStatus.officialApi.pageId }] : []}
        message={oauthLoadError || messagingNextStep(oauthStatus?.officialApi, "facebook")}
        onConnect={() => void handleOAuthConnect()}
        onAuthorizeFeature={scope => void handleOAuthConnect(scope)}
        connecting={connecting}
        onDisconnect={handleDisconnect}
        onRetry={loadAll}
        capabilities={oauthStatus?.officialApi.capabilities}
        primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/outreach/inbox">Open Inbox</Link></Button>}
        secondaryActions={oauthStatus?.officialApi.instagramAccountId && <Button asChild variant="outline" className="rounded-full"><Link href="/dashboard/integrations/instagram">Connect Instagram</Link></Button>}
        selection={oauthStatus?.officialApi.credentialId ? <ChannelAccountSelector variant={oauthStatus.officialApi.selectionRequired ? "card" : "button"} key={oauthStatus?.officialApi.credentialId || "accounts"} platform="facebook_api" label="Facebook Page" onChanged={loadStatus} /> : null}
        settings={connections}
      /></>}
      disconnectDialog={disconnectDialog}
    />
  );
}
