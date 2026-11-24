"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Youtube } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { YouTubeStudioPanel } from "./YouTubeStudioPanel";

type YouTubeStatus = {
  connected: boolean;
  channelId?: string | null;
  channelName?: string | null;
  tokenExpiry?: string | null;
  refreshAvailable?: boolean;
  readiness?: "ready" | "needs_reconnect" | "disconnected";
};

export default function YouTubeIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const result = await api.get<YouTubeStatus>("/api/youtube/oauth/status");
      setStatus(result);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "YouTube connection status could not be checked.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => {
    const connected = searchParams.get("youtube_connected") === "true";
    const error = searchParams.get("youtube_error");
    if (!connected && !error) return;
    toast(connected
      ? { title: "YouTube connected", description: "Your channel is ready for publishing." }
      : { title: "YouTube connection failed", description: error || "Try again.", variant: "destructive" });
    router.replace("/dashboard/integrations/youtube");
    if (connected) void loadStatus();
  }, [loadStatus, router, searchParams, toast]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const result = await api.get<{ authUrl: string }>("/api/youtube/oauth/auth");
      if (!result.authUrl) throw new Error("YouTube sign-in could not be started.");
      window.location.assign(result.authUrl);
    } catch (error) {
      toast({ title: "Connection failed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
      setConnecting(false);
    }
  };

  const confirmDisconnect = async () => {
    try {
      await api.post("/api/youtube/oauth/disconnect");
      setShowDisconnectDialog(false);
      toast({ title: "YouTube disconnected" });
      await loadStatus();
    } catch (error) {
      toast({ title: "Disconnect failed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    }
  };

  const ready = Boolean(status?.connected && status?.readiness !== "needs_reconnect");
  return <IntegrationPageLayout
    icon={Youtube}
    iconBgClass="bg-red-600"
    name="YouTube"
    subtitle="Connect your channel to publish approved videos and Shorts."
    loading={loading}
    loadingIcon={Youtube}
    loadingMessage="Checking YouTube connection..."
    actions={<ConnectionGuideDrawer title="Connect YouTube" description="Connect the Google account that owns or manages your YouTube channel.">
      {close => <div className="space-y-6 rounded-2xl border bg-card p-6"><h2 className="text-xl font-semibold">Connect your channel in three steps</h2><ol className="space-y-4 text-sm leading-6">{[
        ["Choose a Google account", "Use a Google account that has the YouTube channel you want to publish to."],
        ["Allow channel access", "Review the YouTube permissions and approve the access needed for publishing."],
        ["Check your channel", "Return to AskSales and verify the channel name and connection health before publishing."],
      ].map(([title, description], index) => <li key={title} className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-red-500/10 font-semibold text-red-600">{index + 1}</span><span><strong className="block text-foreground">{title}</strong><span className="text-muted-foreground">{description}</span></span></li>)}</ol><Button onClick={() => { close(); void handleConnect(); }} disabled={connecting}>Continue with Google</Button></div>}
    </ConnectionGuideDrawer>}
    fullWidth={<IntegrationWorkspace
      provider="youtube"
      state={loadError ? "unavailable" : status?.readiness === "needs_reconnect" ? "reconnect" : ready ? "connected" : "disconnected"}
      accountName={status?.channelName}
      accountSubtitle={status?.channelId ? `Channel ${status.channelId}` : null}
      accountDetails={status?.channelId ? [{ label: "Channel ID", value: status.channelId }] : undefined}
      message={loadError || (status?.readiness === "needs_reconnect" ? "Your YouTube authorization needs to be renewed." : undefined)}
      onConnect={handleConnect}
      reconnectLabel="Reconnect with Google"
      connecting={connecting}
      onDisconnect={() => setShowDisconnectDialog(true)}
      onRetry={loadStatus}
      primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/saved-templates/social/publish">Publish a video</Link></Button>}
      settingsLabel="YouTube channel options"
      settings={ready ? <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">Authorization renewal</p><p className="mt-1 text-sm font-medium">{status?.refreshAvailable ? "Automatic renewal available" : "Reconnect when authorization expires"}</p></div><div className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">Publishing readiness</p><p className="mt-1 text-sm font-medium">Channel ready</p></div></div><YouTubeStudioPanel /></div> : null}
    />}
    disconnectDialog={<AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Disconnect YouTube?</AlertDialogTitle><AlertDialogDescription>Video publishing will stop until you connect a channel again.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void confirmDisconnect()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Disconnect</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>}
  />;
}
