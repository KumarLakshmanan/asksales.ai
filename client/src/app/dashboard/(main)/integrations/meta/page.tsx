"use client";

import Link from "next/link";
import { selectedBusinessProfileId } from "@/lib/business-profile";
import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { Facebook, Loader2 } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { metaAdsState, type MetaCapability } from "@/lib/integrations";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { MetaAdsConnectionGuide } from "@/components/integrations/AdsConnectionGuides";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
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
import {
  MetaAccountStatus,
} from "./components/MetaAccountStatus";
import { MetaStatusHeader } from "./components/MetaStatusHeader";

interface PlatformCredential {
  id: number;
  platform: string;
  accountName?: string;
  isActive: boolean;
  connectedAt: string;
  expiresAt?: string;
  adAccountId?: string | null;
  pageId?: string | null;
  selectionRequired?: boolean;
  capabilities?: MetaCapability[];
}

export default function MetaIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [metaStatus, setMetaStatus] = useState<PlatformCredential | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await api.get<{ platforms: PlatformCredential[] }>("/api/meta/oauth/platforms");
      const meta = response.platforms?.find(p => p.platform === "meta");
      setMetaStatus(meta || null);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load the Meta connection");
      throw error;
    }
  }, []);

  const loadAllSettings = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      try {
        await loadStatus();
      } catch {
        // The persistent error state below provides a retry action.
      }
    } finally {
      setLoading(false);
    }
  }, [loadStatus]);

  useEffect(() => {
    const error = searchParams.get("error");
    const connected = searchParams.get("meta_connected");
    if (error) {
      toast({ title: "Meta Connection Error", description: error, variant: "destructive" });
      router.replace("/dashboard/integrations/meta");
    } else if (connected === "true") {
      toast({ title: "Authorization received", description: "Choose your ad account and Page to finish connecting Meta Ads." });
      router.replace("/dashboard/integrations/meta");
    }
  }, [searchParams, toast, router]);

  useEffect(() => {
    loadAllSettings();
  }, [loadAllSettings]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const { url } = await api.get<{ url: string }>(`/api/meta/oauth?format=json&businessProfileId=${selectedBusinessProfileId()}`);
      if (!url) throw new Error("Sign-in could not be started. Please try again.");
      window.location.assign(url);
    } catch (error) {
      toast({ title: "Unable to connect", description: error instanceof Error ? error.message : "Try again or contact support.", variant: "destructive" });
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setShowDisconnectDialog(true);
  };

  const confirmDisconnect = async () => {
    try {
      await api.delete("/api/meta/oauth/platforms/meta");
      toast({ title: "Disconnected", description: "Meta account disconnected successfully" });
      setMetaStatus(null);
      void loadStatus().catch(() => undefined);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to disconnect account";
      toast({ title: "Error", description: message, variant: "destructive" });
    }
  };

  const isConnected = metaStatus?.isActive;

  return (
    <IntegrationPageLayout
      icon={Facebook}
      iconBgClass="bg-blue-600"
      iconShadowClass="shadow-blue-600/20"
      name="Meta Ads"
      subtitle="Official Meta Marketing API setup"
      loading={loading}
      loadingIcon={Loader2}
      loadingIconColor="text-blue-600"
      loadingMessage="Connecting to Meta Ads..."
      statusHeader={
        <MetaStatusHeader
          connected={isConnected || false}
          accountName={metaStatus?.accountName || null}
        />
      }
      actions={<ConnectionGuideDrawer title="Connect Meta Ads" description="Authorize your ad account and select the Page used for ads.">
        {close => <MetaAdsConnectionGuide onConnect={() => { close(); void handleConnect(); }} connecting={connecting} />}
      </ConnectionGuideDrawer>}
      fullWidth={<><IntegrationWorkspace
        provider="meta"
        state={loadError ? "unavailable" : metaAdsState(metaStatus)}
        accountName={metaStatus?.accountName}
        accountSubtitle="Meta advertising account"
        accountDetails={[...(metaStatus?.adAccountId ? [{ label: "Ad account", value: metaStatus.adAccountId }] : []), ...(metaStatus?.pageId ? [{ label: "Page ID", value: metaStatus.pageId }] : [])]}
        message={loadError || (metaStatus?.selectionRequired ? "Choose the authorized ad account and Facebook Page that AskSales should use." : metaAdsState(metaStatus) === "action_required" ? "Some advertising permissions were not granted. Reconnect and allow access to your ad account." : undefined)}
        onConnect={handleConnect}
        connecting={connecting}
        onDisconnect={handleDisconnect}
        onRetry={loadAllSettings}
        primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/ads">Manage campaigns</Link></Button>}
        settingsLabel="Ad account and Page settings"
        settings={<>
          {loadError && (
            <Callout
              tone="danger"
              title="Meta connection status is unavailable"
              actions={<Button variant="outline" size="sm" onClick={loadAllSettings}>Try again</Button>}
            >
              {loadError}
            </Callout>
          )}
          {isConnected && <MetaAccountStatus
            isConnected={isConnected || false}
            metaStatus={metaStatus}
            onChanged={loadStatus}
          />}
        </>}
      /></>}
      disconnectDialog={
        <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect Meta?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove your Meta account connection. Facebook and Instagram ad features will stop working until reconnected.
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
