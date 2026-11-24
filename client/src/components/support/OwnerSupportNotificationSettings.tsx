"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Check, ChevronDown, ExternalLink, Mail, MessageCircle, RefreshCw, RotateCcw, Users } from "lucide-react";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { selectedBusinessProfileId } from "@/lib/business-profile";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { SettingsPanel, SettingsSaveBar, SettingsTabs } from '@/components/settings/SettingsSurface';
import { BRAND_URL } from "@/lib/brand";

interface ProviderTemplate { id: number; name: string; language: string; body?: string; compatible: boolean; reasons: string[]; parameterCount: number }
interface SupportNotificationSettings {
  email: { enabled: boolean; providerState: string; subject: string; text: string; preview: { subject: string; text: string; html: string } };
  whatsapp: { enabled: boolean; providerState: string; templateId?: number | null; templateName?: string | null; language?: string | null; preview?: string | null; templates: ProviderTemplate[] };
  recipients: Array<{ memberId: number; memberName: string; teamName: string; active: boolean; emailReady: boolean; emailHint?: string | null; whatsappReady: boolean; whatsappHint?: string | null; memberProfileUrl: string }>;
}
interface NotificationHealth {
  recentFailures: Array<{ id: number; channel: string; status: string; error_code?: string; destination_hint?: string }>;
  recentDeliveries: Array<{ id: number; channel: string; status: string; provider_status?: string; destination_hint?: string }>;
}

const WHATSAPP_TEMPLATE_GUIDANCE = "Choose an available approved support ticket template before enabling or saving WhatsApp notifications.";

const DEFAULT_SUBJECT = "{{event_title}} · {{ticket_number}}";
const DEFAULT_TEXT = `{{event_title}}

Ticket: {{ticket_number}}
Priority: {{priority}}
Source: {{source_channel}}
Issue: {{safe_summary}}
Required action: {{required_action}}
Response target: {{response_target}}

Open ticket: {{ticket_url}}`;

export function OwnerSupportNotificationSettings() {
  const { user, workspaceRole } = useAuth();
  const profiles = useBusinessProfiles();
  if (profiles.isLoading) return <LoadingSettings />;
  if (profiles.isError) return <div role="alert" className="space-y-3 rounded-xl border p-5"><p>Notification workspace could not be verified.</p><Button variant="outline" onClick={() => void profiles.refetch()}>Retry workspace</Button></div>;
  const profile = profiles.activeProfile;
  if (!user || !profile || (profile.role ?? workspaceRole) !== "owner") return <p role="status">Notification settings require workspace owner access.</p>;
  // Remount before displaying another account/workspace/role's state or drafts.
  return <NotificationSettings key={`${user.id}:${profile.id}:${profile.role ?? workspaceRole}`} workspaceId={profile.id} />;
}

function LoadingSettings() {
  return <LoadingState className="min-h-72" label="Loading notification settings…" showLabel />;
}

function NotificationSettings({ workspaceId }: { workspaceId: number }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<SupportNotificationSettings | null>(null);
  const [health, setHealth] = useState<{ status: "loading" | "error" | "stale" | "empty" | "success"; data: NotificationHealth | null; refreshing: boolean }>({ status: "loading", data: null, refreshing: true });
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [message, setMessage] = useState(DEFAULT_TEXT);
  const [templateId, setTemplateId] = useState("");
  const [emailEnabled, setEmailEnabled] = useState(false), [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [tab, setTab] = useState("channels");
  const [loading, setLoading] = useState(true);
  const [settingsError, setSettingsError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState<"email" | "whatsapp" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [retrying, setRetrying] = useState<number[]>([]);
  const mounted = useRef(false);
  const settingsRequest = useRef(0);
  const healthRequest = useRef(0);
  const settingsBusy = useRef(false);
  const mutationBusy = useRef(false);
  const retries = useRef(new Set<number>());
  const baseline = useRef<SupportNotificationSettings | null>(null);
  const healthData = useRef<NotificationHealth | null>(null);
  const draft = useRef({ subject: DEFAULT_SUBJECT, message: DEFAULT_TEXT, templateId: "", emailEnabled: false, whatsappEnabled: false });
  const emailRevision = useRef(0);
  const templateRevision = useRef(0);
  const current = useCallback(() => mounted.current && selectedBusinessProfileId() === workspaceId, [workspaceId]);
  const emailDirty = !!settings && (subject !== settings.email.subject || message !== settings.email.text || emailEnabled !== settings.email.enabled);
  const templateDirty = !!settings && (templateId !== initialTemplate(settings) || whatsappEnabled !== settings.whatsapp.enabled);
  useUnsavedChanges(emailDirty || templateDirty, "You have unsaved notification settings. Leave without saving?");

  const editEmail = (nextSubject: string, nextMessage: string) => {
    emailRevision.current++;
    draft.current = { ...draft.current, subject: nextSubject, message: nextMessage };
    setSubject(nextSubject); setMessage(nextMessage); setFeedback("");
  };
  const editTemplate = (value: string) => {
    templateRevision.current++;
    draft.current.templateId = value; setTemplateId(value); setFeedback("");
    setActionError(error => error === WHATSAPP_TEMPLATE_GUIDANCE ? null : error);
  };
  const applyEmail = (next: SupportNotificationSettings) => {
    draft.current = { ...draft.current, subject: next.email.subject, message: next.email.text };
    setSubject(next.email.subject); setMessage(next.email.text); setEmailEnabled(next.email.enabled); draft.current.emailEnabled = next.email.enabled;
  };
  const applyTemplate = (value: string, enabled: boolean) => { draft.current.templateId = value; draft.current.whatsappEnabled = enabled; setTemplateId(value); setWhatsappEnabled(enabled); };

  const readHealth = useCallback(async () => {
    if (!current()) return;
    const request = ++healthRequest.current;
    setHealth({ status: healthData.current ? "stale" : "loading", data: healthData.current, refreshing: true });
    try {
      const next = await api.get<NotificationHealth>("/api/support/notification-health");
      if (!current() || request !== healthRequest.current) return;
      if (!next || !Array.isArray(next.recentFailures) || !Array.isArray(next.recentDeliveries)) throw new Error("Notification health is unavailable.");
      healthData.current = next;
      setHealth({ status: next.recentFailures.length || next.recentDeliveries.length ? "success" : "empty", data: next, refreshing: false });
    } catch {
      if (!current() || request !== healthRequest.current) return;
      setHealth({ status: healthData.current ? "stale" : "error", data: healthData.current, refreshing: false });
    }
  }, [current]);

  const readSettings = useCallback(async () => {
    if (!current()) return;
    const request = ++settingsRequest.current;
    const emailVersion = emailRevision.current;
    const templateVersion = templateRevision.current;
    const keepEmail = baseline.current && (draft.current.subject !== baseline.current.email.subject || draft.current.message !== baseline.current.email.text || draft.current.emailEnabled !== baseline.current.email.enabled);
    const keepTemplate = baseline.current && (draft.current.templateId !== initialTemplate(baseline.current) || draft.current.whatsappEnabled !== baseline.current.whatsapp.enabled);
    settingsBusy.current = true;
    setLoading(true); setSettingsError(false);
    try {
      const next = await api.get<SupportNotificationSettings>("/api/support/notification-settings");
      if (!current() || request !== settingsRequest.current) return;
      baseline.current = next; setSettings(next);
      if (!keepEmail && emailVersion === emailRevision.current) applyEmail(next);
      if (!keepTemplate && templateVersion === templateRevision.current) applyTemplate(initialTemplate(next), next.whatsapp.enabled);
    } catch {
      if (current() && request === settingsRequest.current) setSettingsError(true);
    } finally {
      if (current() && request === settingsRequest.current) { settingsBusy.current = false; setLoading(false); }
    }
  }, [current]);

  useEffect(() => {
    mounted.current = true;
    const settingsRequests = settingsRequest;
    const healthRequests = healthRequest;
    void readSettings(); void readHealth();
    return () => { mounted.current = false; settingsRequests.current++; healthRequests.current++; };
  }, [readSettings, readHealth]);

  const saveEmail = async (enabled = draft.current.emailEnabled) => {
    if (!current() || mutationBusy.current || settingsBusy.current || !settings) return false;
    mutationBusy.current = true; setSaving("email"); setActionError(null); setFeedback("");
    const revision = emailRevision.current;
    const submitted = { enabled, subject: draft.current.subject, text: draft.current.message };
    try {
      const next = await api.put<SupportNotificationSettings>("/api/support/notification-settings/email", submitted);
      if (!current()) return;
      baseline.current = next; setSettings(next);
      if (revision === emailRevision.current) applyEmail(next);
      setFeedback(revision === emailRevision.current ? "Email settings saved." : "Email settings saved. Newer edits remain unsaved.");
      toast({ title: "Email notification settings saved" }); return true;
    } catch (error) {
      if (!current()) return;
      setActionError("Unable to save email notifications. Your draft is kept; try saving again.");
      toast({ title: "Unable to save email notifications", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }); return false;
    } finally { if (current()) { mutationBusy.current = false; setSaving(null); } }
  };
  const saveWhatsapp = async (enabled = draft.current.whatsappEnabled) => {
    if (!current() || mutationBusy.current || settingsBusy.current || !settings) return false;
    if (enabled && !baseline.current?.whatsapp.templates.some(template => isEligibleTemplate(template) && String(template.id) === draft.current.templateId)) {
      setActionError(WHATSAPP_TEMPLATE_GUIDANCE);
      toast({ title: "Choose an approved template", description: WHATSAPP_TEMPLATE_GUIDANCE, variant: "destructive" }); return false;
    }
    mutationBusy.current = true; setSaving("whatsapp"); setActionError(null); setFeedback("");
    const revision = templateRevision.current;
    try {
      const next = await api.put<SupportNotificationSettings>("/api/support/notification-settings/whatsapp", { enabled, whatsappTemplateId: draft.current.templateId ? Number(draft.current.templateId) : null });
      if (!current()) return;
      baseline.current = next; setSettings(next);
      if (revision === templateRevision.current) applyTemplate(initialTemplate(next), next.whatsapp.enabled);
      setFeedback(revision === templateRevision.current ? "WhatsApp settings saved." : "WhatsApp settings saved. Newer edits remain unsaved.");
      toast({ title: "WhatsApp notification settings saved" }); return true;
    } catch (error) {
      if (!current()) return;
      setActionError("Unable to save WhatsApp notifications. Your template selection is kept; try saving again.");
      toast({ title: "Unable to save WhatsApp notifications", description: error instanceof Error ? error.message : "Please check the connection and template.", variant: "destructive" }); return false;
    } finally { if (current()) { mutationBusy.current = false; setSaving(null); } }
  };
  const syncTemplates = async () => {
    if (!current() || mutationBusy.current || settingsBusy.current) return;
    mutationBusy.current = true; setSyncing(true); setActionError(null);
    try {
      await api.post("/api/whatsapp/templates/sync", {});
      if (!current()) return;
      await Promise.all([readSettings(), readHealth()]);
      if (current()) toast({ title: "WhatsApp templates synced" });
    } catch (error) {
      if (!current()) return;
      setActionError("Unable to sync templates. Your drafts are kept.");
      toast({ title: "Unable to sync templates", description: error instanceof Error ? error.message : "Check the WhatsApp connection.", variant: "destructive" });
    } finally { if (current()) { mutationBusy.current = false; setSyncing(false); } }
  };
  const retryDelivery = async (deliveryId: number) => {
    if (!current() || health.status === "stale" || retries.current.has(deliveryId)) return;
    retries.current.add(deliveryId); setRetrying([...retries.current]); setActionError(null);
    try {
      await api.post(`/api/support/notification-deliveries/${deliveryId}/retry`, {});
      if (!current()) return;
      toast({ title: "Notification retry queued" });
      await readHealth();
    } catch (error) {
      if (!current()) return;
      setActionError("Unable to retry notification. No retry was confirmed; refresh delivery status before trying again.");
      toast({ title: "Unable to retry notification", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { if (current()) { retries.current.delete(deliveryId); setRetrying([...retries.current]); } }
  };
  const sampleEmail = useMemo(() => {
    const sample: Record<string, string> = { event_title: "Ticket assignment", ticket_number: "TKT-1042", priority: "HIGH", source_channel: "WhatsApp", safe_summary: "A customer needs help choosing the right room.", required_action: "Review and reply in the support portal.", response_target: "20 minutes remaining", ticket_url: `${BRAND_URL}/support/tickets/123` };
    const render = (value: string) => Object.entries(sample).reduce((output, [key, replacement]) => output.replaceAll(`{{${key}}}`, replacement), value);
    return { subject: render(subject), text: render(message) };
  }, [message, subject]);

  if (loading && !settings) return <LoadingSettings />;
  if (!settings) return <Card role="alert" className="border-dashed"><CardContent className="flex flex-col items-center gap-3 p-8 text-center"><p className="text-sm font-medium">Notification settings are unavailable</p><p className="text-xs text-muted-foreground">Check the connection and try loading this page again.</p><Button type="button" variant="outline" size="sm" onClick={() => void readSettings()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Try again</Button></CardContent></Card>;
  const eligibleWhatsappTemplates = settings.whatsapp.templates.filter(isEligibleTemplate);
  const selectedTemplate = eligibleWhatsappTemplates.find((template) => String(template.id) === templateId);
  const failures = health.data?.recentFailures || []; const recent = health.data?.recentDeliveries || [];
  const busy = saving !== null || syncing || loading;

  const dirty = emailDirty || templateDirty;
  const toggleEmail = (enabled: boolean) => { if (!current() || mutationBusy.current || settingsBusy.current) return; emailRevision.current++; draft.current.emailEnabled = enabled; setEmailEnabled(enabled); setFeedback(""); };
  const toggleWhatsapp = (enabled: boolean) => {
    if (!current() || mutationBusy.current || settingsBusy.current) return;
    if (enabled && (!baseline.current?.whatsapp.templates.some(template => isEligibleTemplate(template) && String(template.id) === draft.current.templateId) || !["available", "connected"].includes(baseline.current.whatsapp.providerState))) { setActionError(WHATSAPP_TEMPLATE_GUIDANCE); toast({ title: "Choose an approved template", description: WHATSAPP_TEMPLATE_GUIDANCE, variant: "destructive" }); return; }
    templateRevision.current++; draft.current.whatsappEnabled = enabled; setWhatsappEnabled(enabled); setFeedback("");
  };
  const discard = () => { if (baseline.current) { emailRevision.current++; templateRevision.current++; applyEmail(baseline.current); applyTemplate(initialTemplate(baseline.current), baseline.current.whatsapp.enabled); setFeedback("Draft changes discarded. Latest loaded settings restored."); setActionError(null); } };
  const saveChanges = async () => {
    if (busy || !dirty) return;
    if (templateDirty && whatsappEnabled && !selectedTemplate) { setActionError(WHATSAPP_TEMPLATE_GUIDANCE); setTab('templates'); return; }
    if (emailDirty && !await saveEmail()) return;
    if (templateDirty && !await saveWhatsapp()) return;
    if (current()) setFeedback("Notification changes saved. Any newer edits remain unsaved.");
  };
  const recipientPreview = <section className="overflow-hidden rounded-xl border border-border/60 bg-card "><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4"><div><h3 className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-primary" />Recipient readiness</h3><p className="mt-1 text-xs text-muted-foreground">Contact details are managed on the member profile. The saved channel switches decide whether those destinations are used.</p></div><Badge variant="outline">{settings.recipients.length} members</Badge></div>{settings.recipients.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">Add a support member to see recipient readiness.</div> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-muted/25 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Member</th><th className="px-4 py-3 font-medium">Team</th><th className="px-4 py-3 font-medium">Email</th><th className="px-4 py-3 font-medium">WhatsApp</th><th className="px-5 py-3 text-right font-medium">Contact</th></tr></thead><tbody className="divide-y divide-border/50">{settings.recipients.map((recipient) => <tr key={recipient.memberId}><td className="px-5 py-3.5"><div className="font-medium">{recipient.memberName}</div>{!recipient.active && <span className="text-[10px] text-muted-foreground">Disabled member</span>}</td><td className="px-4 py-3.5 text-muted-foreground">{recipient.teamName}</td><td className="px-4 py-3.5"><Readiness ready={recipient.emailReady} hint={recipient.emailHint} label="email" /></td><td className="px-4 py-3.5"><Readiness ready={recipient.whatsappReady} hint={recipient.whatsappHint} label="WhatsApp" /></td><td className="px-5 py-3.5 text-right"><Button asChild variant="ghost" size="sm"><Link href={recipient.memberProfileUrl}>{recipient.emailReady && recipient.whatsappReady ? "Edit" : "Add missing contact"}</Link></Button></td></tr>)}</tbody></table></div>}</section>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">{dirty ? "Unsaved changes. Refresh keeps your drafts." : "Showing saved notification settings."} Channel changes take effect only after you save.</p><Button variant="outline" size="sm" disabled={busy} onClick={() => void readSettings()}><RefreshCw aria-hidden className="mr-1.5 h-3.5 w-3.5" />Refresh settings</Button></div>
    {loading && <p role="status" className="text-xs text-muted-foreground">Refreshing notification settings. Unsaved drafts are kept.</p>}
    {settingsError && <p role="alert" className="rounded-xl border p-4 text-sm">Notification settings could not be refreshed. Showing last loaded settings; drafts are kept. Use Refresh settings to try again.</p>}
    {actionError && <p role="alert" className="rounded-xl border p-4 text-sm text-destructive">{actionError}</p>}
    {feedback && <p role="status" className="text-sm">{feedback}</p>}
    <Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-5">
      <SettingsTabs label="Notification settings sections" items={[{value:'channels',label:'Channels'},{value:'templates',label:'Message templates'},{value:'recipients',label:'Recipients'},{value:'delivery',label:'Delivery activity'}]}/>
      <TabsContent value="channels" className="mt-0 space-y-5">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)]">
          <SettingsPanel title="Notification channels" description="Set up the channels you want to use for support ticket alerts.">
            <div className="overflow-hidden rounded-lg border">
              <ChannelCard icon={Mail} title="Email" description="Send ticket assignment alerts to the assigned member’s support login email." enabled={emailEnabled} busy={busy} providerState={settings.email.providerState} onToggle={toggleEmail}>
                <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={()=>setTab('templates')}>Edit email template</Button>{!["available","connected"].includes(settings.email.providerState) && <p className="text-xs leading-5 text-muted-foreground">Provider configuration is unavailable. Ask an administrator to review the email notification provider.</p>}</div>
              </ChannelCard>
              <ChannelCard icon={MessageCircle} title="WhatsApp" description="Use an approved Utility template and each assigned member’s saved WhatsApp number." enabled={whatsappEnabled} busy={busy} providerState={settings.whatsapp.providerState} enableBlocked={!selectedTemplate} toggleDescriptionId={!selectedTemplate ? "support-whatsapp-template-guidance" : undefined} onToggle={toggleWhatsapp}>
                <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={()=>setTab('templates')}>Choose message template</Button><Button asChild variant="outline" size="sm"><Link href="/dashboard/integrations/whatsapp">Manage WhatsApp</Link></Button></div>
                {!selectedTemplate && <p id="support-whatsapp-template-guidance" role="status" className="mt-3 text-xs leading-5 text-muted-foreground">{WHATSAPP_TEMPLATE_GUIDANCE}</p>}
              </ChannelCard>
            </div>
            {(!["available","connected"].includes(settings.email.providerState) || !["available","connected"].includes(settings.whatsapp.providerState) || !selectedTemplate) && <Callout tone="warning" className="mt-4">Complete channel setup before enabling alerts.</Callout>}
          </SettingsPanel>
          <SettingsPanel title="Who receives alerts?"><h3 className="flex items-center gap-2 text-sm font-semibold"><Users aria-hidden className="h-5 w-5 text-primary"/>Assigned ticket member</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Applies to every support team in this workspace. Only the assigned or reassigned member receives the external alert.</p><p className="mt-5 border-t pt-5 text-sm leading-6 text-muted-foreground">Unassigned tickets stay in the owner&apos;s in-app queue.</p></SettingsPanel>
        </div>
        {recipientPreview}
      </TabsContent>
      <TabsContent value="templates" className="mt-0">
        <fieldset disabled={busy} className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
          <SettingsPanel title="Email template" description="Edit the subject and plain-text message used for ticket assignment alerts.">
            <div className="space-y-4"><div className="space-y-2"><Label htmlFor="support-email-subject">Subject</Label><Input id="support-email-subject" value={subject} onChange={event=>editEmail(event.target.value,message)}/></div><div className="space-y-2"><Label htmlFor="support-email-message">Plain-text message</Label><textarea id="support-email-message" className="min-h-48 w-full rounded-lg border border-input bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={message} onChange={event=>editEmail(subject,event.target.value)}/></div>
              <div className="rounded-lg border bg-muted/20 p-4"><h3 className="text-sm font-semibold">Example preview</h3><p className="mt-3 break-words text-sm font-medium">{sampleEmail.subject}</p><p className="mt-3 whitespace-pre-line break-words text-xs leading-5 text-muted-foreground">{sampleEmail.text}</p></div>
              <Button variant="outline" size="sm" onClick={()=>editEmail(DEFAULT_SUBJECT,DEFAULT_TEXT)}><RotateCcw aria-hidden className="mr-2 h-4 w-4"/>Restore default</Button><p className="text-xs text-muted-foreground">Restore default updates your draft. Save changes to apply it.</p>
            </div>
          </SettingsPanel>
          <SettingsPanel title="WhatsApp template" description="Choose an approved support ticket Utility template.">
            <div className="space-y-4"><div className="space-y-2"><Label htmlFor="support-whatsapp-template">Message template</Label><select id="support-whatsapp-template" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={templateId} onChange={event=>editTemplate(event.target.value)}><option value="">Select an approved Utility template</option>{templateId && !selectedTemplate && <option value={templateId} disabled>Selected template {templateId} · unavailable</option>}{eligibleWhatsappTemplates.map(template=><option key={template.id} value={template.id}>{template.name} · {template.language}</option>)}</select></div>
              {selectedTemplate ? <div className="rounded-lg border bg-muted/20 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><Check aria-hidden className="h-4 w-4 text-success"/>Approved template preview</h3><p className="mt-3 whitespace-pre-line text-xs leading-5">{selectedTemplate.body || settings.whatsapp.preview || "The approved template will be rendered with the ticket summary."}</p></div> : <Callout tone="warning" announce>{templateId ? "The selected template is unavailable. " : "No approved support ticket template is selected. "}{WHATSAPP_TEMPLATE_GUIDANCE}{whatsappEnabled && " You can still disable WhatsApp notifications."}</Callout>}
              <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" loading={syncing} loadingText="Syncing…" disabled={saving !== null || loading} onClick={()=>void syncTemplates()}><RefreshCw aria-hidden className="mr-2 h-4 w-4"/>Sync from Meta</Button><Button variant="outline" size="sm" asChild><Link href="/dashboard/integrations/whatsapp/templates/create?preset=support_ticket_assignment"><ExternalLink aria-hidden className="mr-2 h-4 w-4"/>Create template</Link></Button></div><p className="text-xs leading-5 text-muted-foreground">Sync from Meta imports provider templates into this workspace and keeps your drafts.</p>
            </div>
          </SettingsPanel>
        </fieldset>
      </TabsContent>
      <TabsContent value="recipients" className="mt-0">{recipientPreview}</TabsContent>
      <TabsContent value="delivery" className="mt-0">    <section aria-label="Delivery health" className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <p role={health.status === "error" || (health.status === "stale" && !health.refreshing) ? "alert" : "status"} className="min-w-0 flex-1 text-xs leading-5">
          {health.status === "loading" ? "Checking delivery status…" : health.status === "error" ? "Delivery status is unavailable. Current health is unknown." : health.status === "stale" ? health.refreshing ? "Refreshing delivery status. Showing stale activity; current health is unknown." : "Delivery status could not be refreshed. Showing stale activity; current health is unknown." : health.status === "empty" ? "Delivery status loaded. No delivery activity returned." : "Delivery status loaded."}
        </p>
        <Button type="button" variant="outline" size="sm" disabled={health.refreshing} onClick={() => void readHealth()}><RefreshCw aria-hidden className="mr-1.5 h-3.5 w-3.5" />{health.status === "error" || health.status === "stale" ? "Retry status read" : "Refresh delivery status"}</Button>
      </div>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
          <div className="min-w-0"><h3 className="text-sm font-semibold">Delivery activity</h3><p className="mt-1 text-xs text-muted-foreground">Delivery Retry queues another delivery attempt. Status refresh only reads activity.</p></div>
          <div className="flex shrink-0 items-center gap-2"><Badge variant={health.status === "error" ? "destructive" : failures.length ? "destructive" : "outline"}>{health.status === "loading" ? "Checking status" : health.status === "error" ? "Status unknown" : health.status === "stale" ? `${failures.length} issues · stale` : `${failures.length} issues`}</Badge><ChevronDown aria-hidden className="h-4 w-4 text-muted-foreground" /></div>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border/50 p-5">
          {health.data ? <div className="grid gap-4 lg:grid-cols-2"><ActivityList title="Needs attention" items={failures.map((item) => ({ id: item.id, label: `${item.channel} · ${item.destination_hint || "missing destination"}`, state: item.error_code || item.status, retryable: ["failed", "dead_letter"].includes(item.status) }))} empty={health.status === "stale" ? "No failures in the last loaded activity. Current status is unknown." : "No failed deliveries."} retrying={retrying} retryDisabled={health.status === "stale" || health.refreshing} onRetry={(id) => void retryDelivery(id)} /><ActivityList title="Recent delivery" items={recent.map((item) => ({ id: item.id, label: `${item.channel} · ${item.destination_hint || "masked destination"}`, state: item.provider_status || item.status }))} empty={health.status === "stale" ? "No deliveries in the last loaded activity. Current status is unknown." : "No delivery activity yet."} /></div> : <p className="text-sm text-muted-foreground">{health.status === "loading" ? "Delivery activity is loading." : "Delivery activity is unavailable. Retry the status read to check for failures and deliveries."}</p>}
        </CollapsibleContent>
      </Collapsible>
    </section></TabsContent>
    </Tabs>
    <SettingsSaveBar dirty={dirty} saving={saving!==null} disabled={busy || (templateDirty && whatsappEnabled && !selectedTemplate)} onDiscard={discard} onSave={()=>void saveChanges()}>Changes take effect only after you save.</SettingsSaveBar>
  </div>;
}

function isEligibleTemplate(template: ProviderTemplate) {
  return template.compatible && template.parameterCount === 7;
}

function initialTemplate(settings: SupportNotificationSettings) {
  const fallback = settings.whatsapp.templates.find(isEligibleTemplate);
  return settings.whatsapp.templateId ? String(settings.whatsapp.templateId) : fallback ? String(fallback.id) : "";
}

function ChannelCard({ icon: Icon, title, description, enabled, busy, providerState, enableBlocked = false, toggleDescriptionId, onToggle, children }: { icon: typeof Mail; title: string; description: string; enabled: boolean; busy: boolean; providerState: string; enableBlocked?: boolean; toggleDescriptionId?: string; onToggle: (enabled: boolean) => void; children: ReactNode }) {
  const providerReady = providerState === "available" || providerState === "connected";
  return <div className="border-b p-4 last:border-b-0"><div className="space-y-4"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex min-w-0 flex-1 gap-3"><div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", enabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}><Icon className="h-4 w-4" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{title}</h3><Badge variant="outline" className={cn("text-[9px] font-medium", providerReady ? "text-success" : "text-warning")}>{providerReady ? "Provider ready" : "Setup needed"}</Badge></div><p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{description}</p></div></div><div className="flex shrink-0 items-center justify-between gap-2 sm:justify-start"><span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span><Switch checked={enabled} disabled={busy || (!enabled && (!providerReady || enableBlocked))} aria-describedby={toggleDescriptionId} onCheckedChange={onToggle} aria-label={`${enabled ? "Disable" : "Enable"} ${title} notifications`} /></div></div>{children}</div></div>;
}
function Readiness({ ready, hint, label }: { ready: boolean; hint?: string | null; label: string }) { return <div className="flex items-center gap-2">{ready ? <Check className="h-3.5 w-3.5 text-success" /> : <AlertCircle className="h-3.5 w-3.5 text-warning" />}<span className={ready ? "text-foreground" : "text-muted-foreground"}>{ready ? hint || "Ready" : `Missing ${label}`}</span></div>; }
function ActivityList({ title, items, empty, onRetry, retrying = [], retryDisabled = false }: { title: string; items: Array<{ id: number; label: string; state: string; retryable?: boolean }>; empty: string; onRetry?: (id: number) => void; retrying?: number[]; retryDisabled?: boolean }) { return <div><p className="mb-2 text-xs font-semibold">{title}</p>{items.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">{empty}</p> : <div className="space-y-2">{items.slice(0, 8).map((item) => <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{item.label}</span><Badge variant="outline" className="text-[10px]">{item.state.replaceAll("_", " ")}</Badge>{onRetry && item.retryable && <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={retryDisabled || retrying.includes(item.id)} aria-label={`Retry delivery ${item.id}`} onClick={() => onRetry(item.id)}>{retrying.includes(item.id) ? "Queuing…" : "Retry"}</Button>}</div>)}</div>}</div>; }
