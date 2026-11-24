"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, Smartphone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import { msg91State } from "@/lib/integrations";
import { validateMSG91Settings, type MSG91SettingsResponse } from "@/lib/msg91";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { MSG91Config, type MSG91FormData } from "./components/MSG91Config";
import { MSG91ConnectionGuide } from "./components/MSG91ConnectionGuide";
import { MSG91Callbacks } from "./components/MSG91Callbacks";

const emptyForm: MSG91FormData = { authKey: "", senderId: "", flowId: "", messageVariable: "message" };
const openSettings = () => document.getElementById("connection-settings")?.scrollIntoView({ behavior: "smooth", block: "start" });

export default function MSG91IntegrationPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<MSG91SettingsResponse | null>(null);
  const [formData, setFormData] = useState<MSG91FormData>(emptyForm);
  const [operation, setOperation] = useState<"save" | "test" | "disconnect" | null>(null);
  const mutationActive = useRef(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  const loadStatus = useCallback(async (resetForm = true) => {
    try {
      const result = await api.get<MSG91SettingsResponse>("/api/msg91-settings");
      if (!result.success) throw new Error("SMS connection status could not be loaded.");
      setStatus(result);
      if (resetForm) {
        const saved = result.settings;
        setFormData({ authKey: "", senderId: saved?.senderId || "", flowId: saved?.flowId || "", messageVariable: saved?.messageVariable || "message" });
      }
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "SMS connection status could not be loaded.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const updateConnection = async (kind: "save" | "test") => {
    if (mutationActive.current || loadError || loading) return;
    const submitted = { authKey: formData.authKey.trim(), senderId: formData.senderId.trim().toUpperCase(), flowId: formData.flowId.trim(), messageVariable: formData.messageVariable.trim() };
    const invalid = validateMSG91Settings(submitted);
    if (invalid || (!submitted.authKey && !status?.settings?.hasAuthKey)) {
      toast({ title: "Check SMS settings", description: invalid || "Enter your MSG91 Auth Key.", variant: "destructive" });
      return;
    }
    mutationActive.current = true;
    setOperation(kind);
    try {
      const result = await api.post<{ success: boolean; error?: string }>(kind === "save" ? "/api/msg91-settings" : "/api/msg91-settings/test", submitted);
      if (!result.success) throw new Error(result.error || "MSG91 could not verify the connection.");
      toast(kind === "save"
        ? { title: "SMS connected", description: "Your MSG91 sender and template were verified and saved." }
        : { title: "MSG91 connection verified", description: "The Auth Key, sender, and template match. Save any changes to use them for outreach." });
      await loadStatus(kind === "save");
    } catch (error) {
      toast({ title: kind === "save" ? "SMS setup failed" : "Connection test failed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
      // Testing saved settings may invalidate the stored readiness. Preserve the draft.
      await loadStatus(false);
    } finally { mutationActive.current = false; setOperation(null); }
  };

  const confirmDisconnect = async () => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    setOperation("disconnect");
    try {
      const result = await api.delete<{ success: boolean }>("/api/msg91-settings");
      if (!result.success) throw new Error("SMS could not be disconnected.");
      setShowDisconnectDialog(false);
      setStatus({ success: true, configured: false, connected: false, settings: null });
      setFormData(emptyForm);
      toast({ title: "SMS disconnected" });
      await loadStatus();
    } catch (error) {
      toast({ title: "Disconnect failed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { mutationActive.current = false; setOperation(null); }
  };

  const saved = status?.settings;
  const state = msg91State(status, loadError);
  const busy = operation !== null;
  return <IntegrationPageLayout
    icon={Smartphone}
    iconBgClass="bg-amber-600"
    name="SMS"
    subtitle="Connect MSG91 for SMS outreach, delivery reports, and customer replies."
    loading={loading}
    loadingIcon={Loader2}
    loadingMessage="Checking SMS connection..."
    actions={<ConnectionGuideDrawer title="How to connect MSG91 SMS" description="Verify your sender and template, then set up delivery reports and optional replies.">
      {close => <MSG91ConnectionGuide onConfigure={() => { close(); requestAnimationFrame(openSettings); }} />}
    </ConnectionGuideDrawer>}
    fullWidth={<IntegrationWorkspace
      provider="msg91"
      state={state}
      accountName={saved?.senderId}
      accountSubtitle="MSG91 sender"
      accountDetails={saved ? [{ label: "SMS Template ID", value: saved.flowId }, { label: "Message variable", value: saved.messageVariable }] : undefined}
      message={loadError || (state !== "connected" ? saved?.readinessMessage : null)}
      onConnect={openSettings}
      connectDisabled={busy}
      onDisconnect={busy ? undefined : () => setShowDisconnectDialog(true)}
      onRetry={() => { setLoading(true); void loadStatus(); }}
      primaryAction={<Button asChild className="rounded-full"><Link href="/dashboard/outreach/sms">Open SMS outreach</Link></Button>}
      completeSetup
      reconnectLabel="Update SMS settings"
      settingsLabel="SMS sender settings"
      settings={<div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border bg-card p-4"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" /><div><h3 className="text-sm font-semibold">What you need</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Use your MSG91 Auth Key, an approved six-character Sender ID, and an active SMS Template ID with one message variable. Saving verifies the sender and template before enabling outreach.</p></div></div>
        <MSG91Config formData={formData} onFormChange={data => setFormData(current => ({ ...current, ...data }))} onSave={() => updateConnection("save")} onTest={() => updateConnection("test")} saving={operation === "save"} testing={operation === "test"} hasAuthKey={Boolean(saved?.hasAuthKey)} disabled={busy || Boolean(loadError)} />
        {saved?.lastVerifiedAt && <p className="text-xs text-muted-foreground">Last verified: {new Date(saved.lastVerifiedAt).toLocaleString()}</p>}
        <MSG91Callbacks />
      </div>}
    />}
    disconnectDialog={<AlertDialog open={showDisconnectDialog} onOpenChange={open => { if (!busy) setShowDisconnectDialog(open); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Disconnect SMS?</AlertDialogTitle><AlertDialogDescription>SMS outreach through this MSG91 sender will stop until you connect it again.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void confirmDisconnect(); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{operation === "disconnect" && <Spinner label="Disconnecting" className="mr-2" />}Disconnect</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>}
  />;
}
