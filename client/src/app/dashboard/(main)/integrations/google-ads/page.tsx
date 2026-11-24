"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Globe, Loader2 } from "lucide-react";
import { selectedBusinessProfileId } from "@/lib/business-profile";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { googleAdsState } from "@/lib/integrations";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { GoogleAdsConnectionGuide } from "@/components/integrations/AdsConnectionGuides";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type GoogleAdsConfig = {
  customerId?: string;
  managerAccountId?: string;
  hasRefreshToken?: boolean;
  ready?: boolean;
  providerConfigured?: boolean;
};
type GoogleAdsAccount = {
  customerId: string;
  name?: string;
  currency?: string;
  manager?: boolean;
  managerAccountId?: string;
};

export default function GoogleAdsIntegrationPage() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [config, setConfig] = useState<GoogleAdsConfig | null>(null);
  const [accounts, setAccounts] = useState<GoogleAdsAccount[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountVerified, setAccountVerified] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  const loadAccounts = useCallback(async (customerId?: string) => {
    setLoadingAccounts(true);
    setAccountsError(null);
    setAccountVerified(false);
    try {
      const result = await api.get<{ accounts: GoogleAdsAccount[]; failures?: string[] }>("/api/integrations/google-ads/accounts");
      const eligible = (result.accounts || []).filter(account => !account.manager);
      setAccounts(eligible);
      setAccountVerified(Boolean(customerId && eligible.some(account => account.customerId === customerId)));
      if (!eligible.length) setAccountsError("No eligible Google Ads customer account was found for this Google login.");
      else if (customerId && !eligible.some(account => account.customerId === customerId)) setAccountsError("Your selected customer is no longer available to this Google login. Choose another account below.");
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : "Google Ads accounts could not be loaded.");
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await api.get<{ success: boolean; config: GoogleAdsConfig | null; providerConfigured?: boolean }>("/api/integrations/google-ads/config");
      const next = response.config ? response.config : { providerConfigured: response.providerConfigured };
      setConfig(next);
      setSelectedId(next.customerId || "");
      if (next.hasRefreshToken && next.providerConfigured) await loadAccounts(next.customerId);
      else { setAccounts([]); setAccountVerified(false); }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Google Ads status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [loadAccounts]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => {
    const error = searchParams.get("error");
    const authorized = searchParams.get("google_connected") === "true";
    if (!error && !authorized) return;
    toast(error
      ? { title: "Google Ads connection failed", description: error, variant: "destructive" }
      : { title: "Google account authorized", description: "Choose the Google Ads customer account you want to use." });
    router.replace("/dashboard/integrations/google-ads");
    if (authorized) void loadConfig();
  }, [searchParams, toast, router, loadConfig]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const { url } = await api.get<{ url: string }>(`/api/google-ads/oauth?format=json&businessProfileId=${selectedBusinessProfileId()}`);
      if (!url) throw new Error("Google sign-in could not be started.");
      window.location.assign(url);
    } catch (error) {
      toast({ title: "Unable to connect", description: error instanceof Error ? error.message : "Try again or contact support.", variant: "destructive" });
      setConnecting(false);
    }
  };

  const saveSelection = async () => {
    if (!selectedId) return;
    try {
      setSavingSelection(true);
      await api.post("/api/integrations/google-ads/select", { customerId: selectedId });
      toast({ title: "Google Ads account selected" });
      await loadConfig();
    } catch (error) {
      toast({ title: "Could not select account", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally {
      setSavingSelection(false);
    }
  };

  const confirmDisconnect = async () => {
    try {
      await api.delete("/api/integrations/google-ads/disconnect");
      setShowDisconnectDialog(false);
      toast({ title: "Google Ads disconnected" });
      await loadConfig();
    } catch (error) {
      toast({ title: "Disconnect failed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    }
  };

  const connected = Boolean(config?.hasRefreshToken);
  const ready = Boolean(config?.ready && accountVerified);
  const providerConfigured = Boolean(config?.providerConfigured);
  const selectedAccount = accounts.find(account => account.customerId === config?.customerId);
  const providerUnavailableMessage = "Google Ads isn't enabled for AskSales yet, so you can't connect an account here. Contact support to turn it on; you don't need a developer token.";

  return <IntegrationPageLayout
    icon={Globe}
    iconBgClass="bg-indigo-600"
    name="Google Ads"
    subtitle="Connect a Google account and choose an authorized Ads customer."
    loading={loading}
    loadingIcon={Loader2}
    loadingMessage="Checking Google Ads connection..."
    actions={<ConnectionGuideDrawer title="Connect Google Ads" description="Sign in with Google, then choose the customer account you manage.">
      {close => <GoogleAdsConnectionGuide onConnect={() => { close(); void handleConnect(); }} connecting={connecting} unavailableReason={!loading && !loadError && !providerConfigured ? providerUnavailableMessage : undefined} />}
    </ConnectionGuideDrawer>}
    fullWidth={<IntegrationWorkspace
      provider="google-ads"
      state={loadError ? "unavailable" : googleAdsState({ ready, hasRefreshToken: connected })}
      accountName={connected ? selectedAccount?.name || (config?.customerId ? `Customer ${config.customerId}` : "Google account authorized") : null}
      accountSubtitle={config?.managerAccountId ? `Manager ${config.managerAccountId}` : "Google Ads"}
      accountDetails={config?.customerId ? [{ label: "Customer ID", value: config.customerId }] : undefined}
      message={loadError || (!providerConfigured ? providerUnavailableMessage : connected && accountsError ? accountsError : connected && !ready ? "Choose an authorized customer account below to finish connecting." : undefined)}
      onConnect={handleConnect}
      reconnectLabel="Reconnect with Google"
      connecting={connecting}
      connectDisabled={!providerConfigured}
      onDisconnect={() => setShowDisconnectDialog(true)}
      onRetry={loadConfig}
      primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/ads">Manage campaigns</Link></Button>}
      completeSetup={connected && !ready && providerConfigured}
      settings={connected && providerConfigured ? <div className="space-y-4">
        <div><h3 className="text-sm font-semibold">Choose a Google Ads customer</h3><p className="mt-1 text-sm text-muted-foreground">Only accounts available to your Google login are shown. AskSales manages the developer credentials.</p></div>
        {loadingAccounts ? <LoadingState size="section" label="Loading authorized accounts…" /> : accountsError && !accounts.length ? <Callout tone="warning" role="alert" actions={<Button variant="outline" size="sm" onClick={() => void loadAccounts(config?.customerId)}>Retry</Button>}>{accountsError}</Callout> : <div className="space-y-2" role="radiogroup" aria-label="Google Ads customer account">
          {accounts.map(account => <button key={account.customerId} type="button" role="radio" aria-checked={selectedId === account.customerId} onClick={() => setSelectedId(account.customerId)} className={`flex w-full items-center justify-between rounded-xl border p-4 text-left transition-colors ${selectedId === account.customerId ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}>
            <span><span className="block text-sm font-semibold">{account.name || `Customer ${account.customerId}`}</span><span className="mt-1 block text-xs text-muted-foreground">ID {account.customerId}{account.currency ? ` · ${account.currency}` : ""}{account.managerAccountId ? ` · Manager ${account.managerAccountId}` : ""}</span></span>
            <span aria-hidden="true" className={`h-4 w-4 rounded-full border-2 ${selectedId === account.customerId ? "border-primary bg-primary" : "border-muted-foreground/50"}`} />
          </button>)}
        </div>}
        {accounts.length > 0 && <Button onClick={() => void saveSelection()} disabled={!selectedId || selectedId === config?.customerId || savingSelection}>{savingSelection ? "Saving…" : "Use this account"}</Button>}
      </div> : null}
      settingsLabel="Google Ads customer selection"
    />}
    disconnectDialog={<AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Disconnect Google Ads?</AlertDialogTitle><AlertDialogDescription>AskSales will stop using this Ads account. Your campaigns remain with Google.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void confirmDisconnect()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Disconnect</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>}
  />;
}
