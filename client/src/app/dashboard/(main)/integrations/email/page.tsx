"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Mail, Loader2, Globe2, CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import api from "@/lib/api";
import { selectedBusinessProfileId, selectBusinessProfile, subscribeBusinessProfile } from "@/lib/business-profile";
import { gmailCallbackFailure, gmailSignedInAccount } from "@/lib/gmail-oauth";
import { followUpRecoveryHistoryState } from "@/lib/follow-up-save-recovery";
import { IntegrationWorkspace } from "@/components/integrations/IntegrationWorkspace";
import { GmailConnectionGuide, ResendConnectionGuide } from "@/components/integrations/EmailConnectionGuides";
import { ConnectionGuideDrawer } from "@/components/integrations/ConnectionGuideDrawer";

import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { EmailStatusHeader } from "@/components/integrations/StatusHeader";
import { PageErrorState } from "@/components/ui/page-state";
import { Spinner } from "@/components/ui/spinner";
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

import { GmailIntegration } from "./components/GmailIntegration";
import { ResendDomains } from "./components/ResendDomains";
import { ActiveSenders } from "./components/ActiveSenders";
import { GmailStatus, ResendDomain, EmailSender } from "./components/types";
import { useEmailIntegrationRead } from "./useEmailIntegrationRead";
import { useEmailIntegrationMutation } from "./useEmailIntegrationMutation";
import { copyEmailIntegrationText } from "./copyEmailIntegrationText";
import { GMAIL_AUTHORIZATION_TIMEOUT_MS, useGmailAuthorization } from "./useGmailAuthorization";

export default function EmailIntegrationPage() {
  const captureCopyScope = useEmailIntegrationMutation();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const success = searchParams.get("gmail_success");
  const error = searchParams.get("gmail_error");
  const errorReference = searchParams.get("gmail_error_ref");
  const errorStage = searchParams.get("gmail_error_stage");
  const returnProfile = searchParams.get("gmail_business_profile_id");
  const [failure, setFailure] = useState<(ReturnType<typeof gmailCallbackFailure> & { accountId: number | null }) | null>(null);
  const [recovering, setRecovering] = useState(success === "true" || Boolean(error));
  const handledCallback = useRef<string | null>(null);

  useEffect(() => {
    if (success !== "true" && !error) return;
    const callbackKey = JSON.stringify([success, error, errorReference, errorStage, returnProfile]);
    if (handledCallback.current === callbackKey) return;
    let cancelled = false;
    const accountId = gmailSignedInAccount();
    const startingProfile = selectedBusinessProfileId();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const current = () => !cancelled && gmailSignedInAccount() === accountId;
    void (async () => {
      setRecovering(true);
      try {
        if (error) {
          if (current()) {
            const details = gmailCallbackFailure(error, errorStage, errorReference);
            setFailure({ ...details, accountId });
            toast({ title: "Gmail Connection Error", description: details.message, variant: "destructive", options: { id: "gmail-oauth-result" } });
          }
          return;
        }
        setFailure(null);
        if (returnProfile !== null) {
          const id = /^\d+$/.test(returnProfile) ? Number(returnProfile) : NaN;
          if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid return business");
          if (selectedBusinessProfileId() !== id) {
            const aborted = new Promise<never>((_, reject) => {
              onAbort = () => reject(new DOMException("Gmail return cancelled", "AbortError"));
              controller.signal.addEventListener("abort", onAbort, { once: true });
              timeout = setTimeout(() => controller.abort(), GMAIL_AUTHORIZATION_TIMEOUT_MS);
            });
            const verified = await Promise.race([
              api.get<{ id: number; archivedAt?: string | null }>(`/api/settings/business-profiles/${id}`, { signal: controller.signal }),
              aborted,
            ]);
            if (!current()) return;
            if (selectedBusinessProfileId() !== startingProfile) throw new Error("Selected business changed");
            if (verified.id !== id || verified.archivedAt) throw new Error("Return business unavailable");
            selectBusinessProfile(id);
          }
        }
        if (current()) toast({ title: "Gmail Connected", description: "Your Gmail account is connected. Check reply sync below.", options: { id: "gmail-oauth-result" } });
      } catch {
        if (current()) toast({ title: "Check Gmail Connection", description: "Return to the business where you started Gmail sign-in to check its connection.", variant: "destructive", options: { id: "gmail-oauth-result" } });
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        if (current()) {
          handledCallback.current = callbackKey;
          // These callback fields have been consumed locally. A route transition
          // can reuse the prerendered route's canonical callback URL, so replace
          // the current history entry through Next's supported history API.
          const url = new URL(window.location.href);
          for (const key of ["gmail_success", "gmail_error", "gmail_error_ref", "gmail_error_stage", "gmail_business_profile_id"]) url.searchParams.delete(key);
          window.history.replaceState(followUpRecoveryHistoryState(), "", `${url.pathname}${url.search}${url.hash}`);
          setRecovering(false);
        }
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [error, errorReference, errorStage, returnProfile, success, toast]);

  if (recovering) return <div role="status" className="flex items-center gap-2 p-6"><Spinner label={null} />Checking Gmail connection…</div>;
  const visibleFailure = failure?.accountId === gmailSignedInAccount() ? failure : null;
  return <>
    {visibleFailure && <div className="px-4 pt-4 sm:px-6">
      <Alert variant="destructive" className="text-foreground [&>svg]:text-foreground">
        <CircleAlert className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Gmail connection could not finish</AlertTitle>
        <AlertDescription className="space-y-2 break-words">
          <p>{visibleFailure.message}</p>
          {visibleFailure.stage && <p>Failed step: {visibleFailure.stage}.</p>}
          {visibleFailure.reference && <p className="select-text">Reference: {visibleFailure.reference}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={async () => {
              const current = captureCopyScope();
              const copied = await copyEmailIntegrationText([
                visibleFailure.message,
                visibleFailure.stage ? `Failed while: ${visibleFailure.stage}` : null,
                `Error code: ${visibleFailure.code}`,
                visibleFailure.reference ? `Reference: ${visibleFailure.reference}` : null,
              ].filter(Boolean).join("\n"));
              if (!current()) return;
              if (copied) toast({ title: "Error details copied" });
              else toast({ title: "Could not copy details", description: "Select and copy the error text above.", variant: "destructive" });
            }}>Copy error details</Button>
            <Button variant="ghost" size="sm" onClick={() => setFailure(null)}>Dismiss</Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>}
    <EmailIntegrationSettings key={profileId ?? "default"} />
  </>;
}

function EmailIntegrationSettings() {
  const { toast } = useToast();
  const captureMutationScope = useEmailIntegrationMutation();
  const [loading, setLoading] = useState(true);
  const [statusAvailable, setStatusAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Gmail state
  const { data: gmailStatus, load: loadGmailStatus, error: gmailRefreshError, pending: refreshing } = useEmailIntegrationRead<GmailStatus | null>("/api/gmail/oauth/status", "Gmail status", null);
  const connectionError = useCallback((message: string) => {
    toast({ title: "Connection Error", description: message, variant: "destructive" });
  }, [toast]);
  const { connecting, connect: handleConnectGmail } = useGmailAuthorization(connectionError);
  const [disconnecting, setDisconnecting] = useState(false);
  const [settingUpWatch, setSettingUpWatch] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  // Resend Domains state
  const { data: domainData, load: loadResendDomains, error: domainsReadError, cancel: cancelDomainsRead } = useEmailIntegrationRead<{ domains: ResendDomain[] }>("/api/resend/domains", "DNS records", { domains: [] });
  const domains = domainData.domains || [];
  const [domainName, setDomainName] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimeout.current), []);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);
  const [refreshingDnsId, setRefreshingDnsId] = useState<string | null>(null);
  const [dnsRefreshErrorId, setDnsRefreshErrorId] = useState<string | null>(null);
  const dnsAction = useRef<{ id: string } | null>(null);

  // Active Senders state
  const { data: senderData, load: loadEmailSenders, error: sendersReadError, invalidate: invalidateEmailSenders } = useEmailIntegrationRead<{ senders: EmailSender[] }>("/api/email-senders", "Email senders", { senders: [] });
  const emailSenders = senderData.senders || [];
  const [showAddSender, setShowAddSender] = useState(false);
  const [newSenderEmail, setNewSenderEmail] = useState("");
  const [newSenderLabel, setNewSenderLabel] = useState("");
  const [newSenderDisplayName, setNewSenderDisplayName] = useState("");
  const [addingSender, setAddingSender] = useState(false);
  const [selectedDomainId, setSelectedDomainId] = useState<number | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<number | null>(null);
  const [deletingSenderId, setDeletingSenderId] = useState<number | null>(null);

  const loadAttempt = useRef({ version: 0 });

  const loadAll = useCallback(async () => {
    const attemptState = loadAttempt.current;
    const attempt = ++attemptState.version;
    try {
      setLoading(true);
      setLoadError(null);
      const results = await Promise.allSettled([loadGmailStatus(true), loadResendDomains(true), loadEmailSenders(true)]);
      if (attempt !== attemptState.version) return;
      const labels = ["Gmail status", "Resend domains", "email senders"];
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${labels[index]}: ${result.reason instanceof Error ? result.reason.message : "request failed"}`]
          : []
      );
      setStatusAvailable(failures.length === 0);
      setLoadError(failures.length > 0 ? failures.join(" ") : null);
    } finally {
      if (attempt === attemptState.version) setLoading(false);
    }
  }, [loadGmailStatus, loadResendDomains, loadEmailSenders]);

  useEffect(() => {
    const attemptState = loadAttempt.current;
    void loadAll();
    return () => {
      ++attemptState.version;
      dnsAction.current = null;
    };
  }, [loadAll]);

  const confirmDisconnectGmail = async () => {
    const current = captureMutationScope();
    try {
      setDisconnecting(true);
      const result = await api.post<{ warning?: string }>("/api/gmail/oauth/disconnect");
      if (!current()) return;
      invalidateEmailSenders(current => ({ ...current, senders: current.senders.filter(sender => sender.type !== "gmail") }));
      toast({ title: "Gmail disconnected locally", description: result.warning || "Gmail access was removed from this business." });
      // A confirmed write remains successful even if a following read fails.
      // Each scoped loader retains its own error and retry affordance.
      await Promise.allSettled([loadGmailStatus(true), loadEmailSenders(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to disconnect";
      toast({ title: "Disconnect Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setDisconnecting(false);
    }
  };

  const handleRefreshGmail = async () => {
    try {
      await loadGmailStatus();
    } catch {
      // The scoped read error stays visible until a successful retry.
    }
  };

  const handleSetupWatch = async () => {
    const current = captureMutationScope();
    try {
      setSettingUpWatch(true);
      await api.post("/api/gmail/oauth/watch");
      if (!current()) return;
      toast({ title: "Inbox Refreshed", description: "Real-time monitoring for your inbox is active." });
      await Promise.allSettled([loadGmailStatus(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to setup inbox watch";
      toast({ title: "Sync Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setSettingUpWatch(false);
    }
  };

  const handleAddDomain = async () => {
    const current = captureMutationScope();
    if (!domainName) return;
    try {
      setAddingDomain(true);
      await api.post("/api/resend/domains", { name: domainName });
      if (!current()) return;
      toast({ title: "Domain Added", description: "Configuring DNS records for the new domain." });
      setDomainName("");
      await Promise.allSettled([loadResendDomains(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to add domain";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setAddingDomain(false);
    }
  };

  const handleDeleteDomain = async (id: string) => {
    const current = captureMutationScope();
    try {
      setDeletingId(id);
      await api.delete(`/api/resend/domains/${id}`);
      if (!current()) return;
      toast({ title: "Domain Deleted", description: "Domain removed from your account." });
      await Promise.allSettled([loadResendDomains(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to delete domain";
      toast({ title: "Delete Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setDeletingId(null);
    }
  };

  const handleVerifyDomain = async (id: string) => {
    const current = captureMutationScope();
    try {
      setVerifyingId(id);
      const res = await api.post<{ success: boolean; status: string }>(`/api/resend/domains/${id}/verify`);
      if (!current()) return;
      if (res.success && res.status === 'verified') {
        toast({ title: "Domain Verified", description: "DNS records confirmed successfully!" });
      } else {
        toast({ title: "Verification Pending", description: "DNS records not yet propagated. Please try again in a few minutes.", variant: "default" });
      }
      await Promise.allSettled([loadResendDomains(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to verify domain";
      toast({ title: "Verify Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setVerifyingId(null);
    }
  };

  const handleRefreshDns = async (id: string) => {
    if (dnsAction.current?.id === id || expandedDomainId !== id || !domains.some(domain => domain.resendDomainId === id)) return;
    const action = { id };
    dnsAction.current = action;
    setRefreshingDnsId(id);
    try {
      await loadResendDomains(true);
    } catch {
      // The loader retains the prior records and exposes a scoped retry error.
      if (dnsAction.current === action) setDnsRefreshErrorId(id);
    } finally {
      if (dnsAction.current === action) {
        dnsAction.current = null;
        setRefreshingDnsId(null);
      }
    }
  };

  const handleExpandedDomainChange = (id: string | null) => {
    if (id !== expandedDomainId && dnsAction.current) {
      dnsAction.current = null;
      cancelDomainsRead();
      setRefreshingDnsId(null);
    }
    setExpandedDomainId(id);
  };

  const handleSendTest = async (id: number) => {
    const current = captureMutationScope();
    if (!testEmail) return;
    try {
      setSendingTest(true);
      await api.post("/api/resend/send-test", { to: testEmail.trim(), domainId: id });
      if (!current()) return;
      toast({ title: "Test Email Sent", description: `A test message is on its way to ${testEmail}.` });
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to send test email";
      toast({ title: "Test Failed", description: message, variant: "destructive" });
    } finally {
      if (current()) setSendingTest(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    const current = captureMutationScope();
    const copied = await copyEmailIntegrationText(text);
    if (!current()) return;
    clearTimeout(copiedTimeout.current);
    if (!copied) {
      setCopiedValue(null);
      toast({ title: "Could not copy DNS value", description: "Select and copy the DNS value below.", variant: "destructive" });
      return;
    }
    setCopiedValue(text);
    copiedTimeout.current = setTimeout(() => { if (current()) setCopiedValue(null); }, 2000);
    toast({ title: "Copied", description: "Value copied to clipboard." });
  };

  const handleAddSender = async () => {
    const current = captureMutationScope();
    const selectedDomain = domains.find((domain) => domain.id === selectedDomainId);
    const localPart = newSenderEmail.trim();
    const label = newSenderLabel.trim();
    if (!selectedDomain || !localPart || !label) {
      toast({
        title: "Sender details required",
        description: "Choose a verified domain and enter both a label and mailbox name.",
        variant: "destructive",
      });
      return;
    }

    const email = localPart.includes("@") ? localPart : `${localPart}@${selectedDomain.name}`;
    if (!email.toLowerCase().endsWith(`@${selectedDomain.name.toLowerCase()}`)) {
      toast({
        title: "Sender domain mismatch",
        description: `The sender address must use ${selectedDomain.name}.`,
        variant: "destructive",
      });
      return;
    }
    try {
      setAddingSender(true);
      await api.post("/api/email-senders", {
        type: "resend",
        email,
        label,
        displayName: newSenderDisplayName.trim() || undefined,
        resendDomainId: selectedDomainId,
      });
      if (!current()) return;
      toast({ title: "Sender Added", description: "The new verified sender is now active." });
      setShowAddSender(false);
      setNewSenderEmail(""); setNewSenderLabel(""); setNewSenderDisplayName("");
      await Promise.allSettled([loadEmailSenders(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to add sender";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setAddingSender(false);
    }
  };

  const handleDeleteSender = async (id: number) => {
    const current = captureMutationScope();
    try {
      setDeletingSenderId(id);
      await api.delete(`/api/email-senders/${id}`);
      if (!current()) return;
      toast({ title: "Sender Removed", description: "Verified sender deleted successfully." });
      await Promise.allSettled([loadEmailSenders(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to remove sender";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setDeletingSenderId(null);
    }
  };

  const handleSetDefaultSender = async (id: number) => {
    const current = captureMutationScope();
    try {
      setSettingDefaultId(id);
      await api.post(`/api/email-senders/${id}/default`);
      if (!current()) return;
      toast({ title: "Default Set", description: "Primary sending account updated." });
      await Promise.allSettled([loadEmailSenders(true)]);
    } catch (error: unknown) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Failed to update default sender";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      if (current()) setSettingDefaultId(null);
    }
  };

  if (loadError && !loading) {
    return (
      <PageErrorState
        title="Email integration settings could not be loaded"
        description={loadError}
        reset={() => void loadAll()}
      />
    );
  }

  const verifiedSenders = emailSenders.filter(sender => sender.type === "resend" && sender.isVerified && domains.some(domain => domain.status === "verified" && sender.email.endsWith(`@${domain.name}`)));
  const gmailReady = Boolean(gmailStatus?.connected && !gmailStatus.tokenExpired && !gmailStatus.requiresReconnect);
  const savedGmailSender = emailSenders.find(sender => sender.type === "gmail");
  const reconnectEmail = gmailStatus?.email || savedGmailSender?.email || null;
  const gmailNeedsReconnect = !gmailReady && Boolean(gmailStatus?.connected || savedGmailSender);
  const emailReady = gmailReady || verifiedSenders.length > 0;
  const refreshUnavailable = Boolean(gmailRefreshError || domainsReadError || sendersReadError);

  return (
    <IntegrationPageLayout
      icon={Mail}
      iconBgClass="bg-indigo-600"
      iconShadowClass="shadow-indigo-600/20"
      name="Email"
      subtitle={refreshUnavailable ? "Email status could not be refreshed. Last known details are shown below." : gmailReady ? "Your Gmail account is connected. Manage sending domains and sender addresses below." : "Connect Gmail or a verified sending domain, then choose your sender addresses."}
      loading={loading}
      loadingIcon={Loader2}
      loadingIconColor="text-indigo-600"
      loadingMessage="Loading email settings..."
      statusHeader={
        <EmailStatusHeader
          gmailConnected={gmailReady}
          gmailNeedsReconnect={gmailNeedsReconnect}
          resendConnected={domains.some(d => d.status === 'verified')}
          statusAvailable={statusAvailable && !refreshUnavailable}
        />
      }
      actions={<>
        <Button asChild variant="outline" className="rounded-full"><Link href="/dashboard/settings/outreach/email-designs">Email designs</Link></Button>
        {emailReady && !refreshUnavailable && <Button asChild variant="outline" className="rounded-full"><Link href="/dashboard/outreach/inbox?channel=email">Open email inbox</Link></Button>}
        <ConnectionGuideDrawer label="Gmail guide" title="Connect Gmail" description="Authorize your mailbox with Google and check its connection.">
          {close => <GmailConnectionGuide onConnect={() => { close(); void handleConnectGmail(); }} connecting={connecting} />}
        </ConnectionGuideDrawer>
        <ConnectionGuideDrawer label="Resend guide" title="Connect a sending domain" description="Add your domain, publish the DNS records, and create a sender address." icon={Globe2}>
          {close => <ResendConnectionGuide onOpenSetup={() => { close(); document.getElementById("resend-domains")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />}
        </ConnectionGuideDrawer>
      </>}
      fullWidth={<><IntegrationWorkspace
        provider="email"
        layout="settings"
        state={refreshUnavailable ? "unavailable" : emailReady ? "connected" : gmailNeedsReconnect ? "reconnect" : domains.length ? "action_required" : "disconnected"}
        onConnect={handleConnectGmail}
        settingsLabel="Email connections"
        settings={<>
          {refreshUnavailable && <Alert variant="destructive"><AlertTitle>Email status could not be refreshed</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>Last known connection details are shown below and may be out of date.</span><Button variant="outline" size="sm" onClick={() => { void Promise.allSettled([loadGmailStatus(), loadResendDomains(), loadEmailSenders()]); }}>Try again</Button></AlertDescription></Alert>}
          <GmailIntegration
            gmailStatus={gmailStatus || { connected: false, email: null }}
            reconnectEmail={gmailNeedsReconnect ? reconnectEmail : null}
            connecting={connecting}
            disconnecting={disconnecting}
            refreshing={refreshing}
            refreshError={gmailRefreshError}
            settingUpWatch={settingUpWatch}
            onConnect={handleConnectGmail}
            onDisconnect={() => setShowDisconnectDialog(true)}
            onRefresh={handleRefreshGmail}
            onSetupWatch={handleSetupWatch}
          />

          <div id="resend-domains" className="scroll-mt-6"><ResendDomains
            domains={domains}
            domainName={domainName}
            addingDomain={addingDomain}
            verifyingId={verifyingId}
            deletingId={deletingId}
            sendingTest={sendingTest}
            testEmail={testEmail}
            copiedValue={copiedValue}
            expandedDomainId={expandedDomainId}
            onAddDomain={handleAddDomain}
            onDeleteDomain={handleDeleteDomain}
            onVerifyDomain={handleVerifyDomain}
            onSendTest={handleSendTest}
            onSetDomainName={setDomainName}
            onSetTestEmail={setTestEmail}
            onSetExpandedDomainId={handleExpandedDomainChange}
            onRefreshDns={handleRefreshDns}
            refreshingDnsId={refreshingDnsId}
            refreshDnsError={domainsReadError && dnsRefreshErrorId ? { id: dnsRefreshErrorId, message: domainsReadError } : null}
            copyToClipboard={copyToClipboard}
          /></div>

          <ActiveSenders
            emailSenders={emailSenders}
            domains={domains}
            showAddSender={showAddSender}
            newSenderEmail={newSenderEmail}
            newSenderLabel={newSenderLabel}
            newSenderDisplayName={newSenderDisplayName}
            addingSender={addingSender}
            selectedDomainId={selectedDomainId}
            settingDefaultId={settingDefaultId}
            deletingSenderId={deletingSenderId}
            onSetShowAddSender={setShowAddSender}
            onSetNewSenderEmail={setNewSenderEmail}
            onSetNewSenderLabel={setNewSenderLabel}
            onSetNewSenderDisplayName={setNewSenderDisplayName}
            onSetSelectedDomainId={setSelectedDomainId}
            onAddSender={handleAddSender}
            onDeleteSender={handleDeleteSender}
            onSetDefaultSender={handleSetDefaultSender}
          />
        </>}
      /></>}
      disconnectDialog={
        <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove your Gmail account connection. Outreach via Gmail will stop working until reconnected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDisconnectGmail} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}
