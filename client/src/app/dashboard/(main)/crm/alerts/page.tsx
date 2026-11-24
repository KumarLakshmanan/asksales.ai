"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import Link from 'next/link';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Plus, Target, Trash2, Edit, AlertCircle, Bell,
  CheckCircle2, Power, PowerOff, History
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Alert as ErrorAlert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState } from "@/components/ui/page-state";
import { useCrmConfiguration } from "@/hooks/use-crm-configuration";
import { crmStagesForStatuses } from "@/lib/crm-configuration";
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';

interface Alert {
  id: number;
  name: string;
  description: string | null;
  eventType: string;
  conditions: Record<string, unknown>;
  enabled: boolean;
  notifyUser: boolean;
  notifyContact: boolean;
  createdAt: string;
}

interface AlertLog {
  id: number;
  alertId: number;
  alertName: string;
  contactId: number | null;
  contactName: string;
  eventType: string;
  eventData: Record<string, unknown>;
  notifiedUser: boolean;
  notifiedContact: boolean;
  createdAt: string;
}

const EVENT_TYPES = [
  { value: "status_changed_to", label: "Status Changed To" },
  { value: "status_changed_from", label: "Status Changed From" },
  { value: "proposal_sent", label: "Proposal Sent" },
  { value: "ticket_opened", label: "Support Ticket Opened" },
  { value: "ticket_closed", label: "Support Ticket Closed" },
  { value: "lead_created", label: "New Lead Created" },
  { value: "contact_created", label: "New Contact Created" },
  { value: "deal_won", label: "Deal Won" },
  { value: "deal_lost", label: "Deal Lost" },
] as const;

export default function CRMAlertPage() {
  const { toast } = useToast();
  const { stages } = useCrmConfiguration();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const requestVersion = useRef(0), historyVersion = useRef(0), alertsInFlight = useRef(0), logsInFlight = useRef(0);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [logs, setLogs] = useState<AlertLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [tab, setTab] = useState<"rules" | "history">("rules");
  const [search, setSearch] = useState('');
  const [historyAlert, setHistoryAlert] = useState('all');
  const [formBaseline, setFormBaseline] = useState('');

  const [form, setForm] = useState({
    name: "",
    description: "",
    eventType: "status_changed_to",
    stage: "any",
    notifyUser: true,
    notifyContact: false,
  });
  const pipelineStages = crmStagesForStatuses(stages, form.stage === 'any' ? [] : [form.stage]);
  const { confirmLeave, clearGuard } = useUnsavedChanges(showCreate && formBaseline !== JSON.stringify(form), 'Discard your unsaved alert changes?');

  const fetchAlerts = useCallback(async (background = false) => {
    const version = ++requestVersion.current, requestedProfile = selectedBusinessProfileId();
    alertsInFlight.current = version;
    try {
      if (!background) setLoading(true);
      setRulesError(null);
      const resp = await api.get<Alert[]>("/api/crm/alerts");
      if (version !== requestVersion.current || selectedBusinessProfileId() !== requestedProfile) return;
      setAlerts(resp || []);
    } catch (error: unknown) {
      if (version !== requestVersion.current || selectedBusinessProfileId() !== requestedProfile) return;
      setRulesError(error instanceof Error ? error.message : "Failed to load alerts");
      toast({ title: "Error", description: "Failed to load alerts", variant: "destructive" });
    } finally {
      if (version === requestVersion.current && selectedBusinessProfileId() === requestedProfile) setLoading(false);
      if (alertsInFlight.current === version) alertsInFlight.current = 0;
    }
  }, [toast]);

  const fetchLogs = useCallback(async () => {
    const version = ++historyVersion.current, requestedProfile = selectedBusinessProfileId();
    logsInFlight.current = version;
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      const resp = await api.get<AlertLog[]>(historyAlert === 'all' ? '/api/crm/alerts/logs' : `/api/crm/alerts/${historyAlert}/logs`);
      if (version !== historyVersion.current || selectedBusinessProfileId() !== requestedProfile) return;
      setLogs(resp || []);
    } catch (error: unknown) {
      if (version !== historyVersion.current || selectedBusinessProfileId() !== requestedProfile) return;
      setHistoryError(error instanceof Error ? error.message : "Failed to load history");
      toast({ title: "Error", description: "Failed to load history", variant: "destructive" });
    } finally {
      if (version === historyVersion.current && selectedBusinessProfileId() === requestedProfile) setHistoryLoading(false);
      if (logsInFlight.current === version) logsInFlight.current = 0;
    }
  }, [toast, historyAlert]);

  useEffect(() => { setAlerts([]); setLogs([]); setShowCreate(false); setPendingIds([]); setSearch(''); const params = new URLSearchParams(window.location.search); const alertId=Number(params.get('alertId'));setHistoryAlert(Number.isSafeInteger(alertId) && alertId>0 ? String(alertId) : 'all');setTab(params.get('tab')==='history' ? 'history' : 'rules');void fetchAlerts(); }, [fetchAlerts, profileId]);
  useEffect(() => { if (tab === "history") void fetchLogs(); }, [tab, fetchLogs, profileId]);
  // Automatic refreshes (30s poll, socket events) skip a read still running so a
  // slow first load is not discarded and restarted.
  useCrmAutomationRefresh(async () => { if (!alertsInFlight.current) await fetchAlerts(true); if (tab==='history' && !logsInFlight.current) await fetchLogs(); });

  const resetForm = useCallback(() => {
    const next={ name: "", description: "", eventType: "status_changed_to", stage: "any", notifyUser: true, notifyContact: false };setForm(next);setFormBaseline(JSON.stringify(next));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim() || !form.eventType) {
      toast({ title: "Error", description: "Name and event type are required", variant: "destructive" });
      return;
    }
    if (saving) return;
    const requestedProfile = selectedBusinessProfileId();
    setSaving(true);
    try {
      const needsStage = form.eventType === "status_changed_to" || form.eventType === "status_changed_from";
      const payload = {
        name: form.name.trim(),
        description: form.description,
        eventType: form.eventType,
        conditions: needsStage && form.stage && form.stage !== "any" ? { stage: form.stage } : {},
        notifyUser: form.notifyUser,
        notifyContact: form.notifyContact,
      };
      if (editId) {
        await api.put(`/api/crm/alerts/${editId}`, payload);
        toast({ title: "Alert updated" });
      } else {
        await api.post("/api/crm/alerts", payload);
        toast({ title: "Alert created" });
      }
      if (selectedBusinessProfileId() !== requestedProfile) return;
      setShowCreate(false);
      clearGuard();
      setEditId(null);
      resetForm();
      fetchAlerts();
    } catch (error) {
      if (selectedBusinessProfileId() === requestedProfile) toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to save rule", variant: "destructive" });
    } finally { setSaving(false); }
  }, [form, editId, saving, toast, fetchAlerts, resetForm]);

  const handleToggle = useCallback(async (id: number, enabled: boolean) => {
    if (pendingIds.includes(id)) return;
    const requestedProfile = selectedBusinessProfileId();
    setPendingIds(ids => [...ids, id]);
    try {
      await api.put(`/api/crm/alerts/${id}`, { enabled });
      if (selectedBusinessProfileId() !== requestedProfile) return;
      setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled } : a)));
    } catch {
      toast({ title: "Error", description: "Failed to toggle alert", variant: "destructive" });
    } finally { setPendingIds(ids => ids.filter(value => value !== id)); }
  }, [toast, pendingIds]);

  const handleDelete = useCallback(async (id: number) => {
    if (!window.confirm("Delete this alert rule? Existing delivery logs may no longer be available.")) return;
    const requestedProfile = selectedBusinessProfileId();
    try {
      await api.delete(`/api/crm/alerts/${id}`);
      if (selectedBusinessProfileId() !== requestedProfile) return;
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      toast({ title: "Alert deleted" });
    } catch {
      toast({ title: "Error", description: "Failed to delete alert", variant: "destructive" });
    }
  }, [toast]);

  const openEdit = (a: Alert) => {
    setEditId(a.id);
    const conditions = (a.conditions || {}) as Record<string, string>;
    const next={
      name: a.name,
      description: a.description || "",
      eventType: a.eventType,
      stage: conditions.stage || "any",
      notifyUser: a.notifyUser,
      notifyContact: a.notifyContact,
    };setForm(next);setFormBaseline(JSON.stringify(next));
    setShowCreate(true);
  };



  const needsStage = form.eventType === "status_changed_to" || form.eventType === "status_changed_from";
  const normalizedSearch=search.trim().toLocaleLowerCase();
  const visibleAlerts=alerts.filter(alert=>`${alert.name} ${alert.description || ''} ${EVENT_TYPES.find(event=>event.value===alert.eventType)?.label || alert.eventType}`.toLocaleLowerCase().includes(normalizedSearch));
  const visibleLogs=logs.filter(log=>`${log.alertName} ${log.contactName} ${EVENT_TYPES.find(event=>event.value===log.eventType)?.label || log.eventType}`.toLocaleLowerCase().includes(normalizedSearch));

  if (loading) {
    return (
      <LoadingState size="section" className="min-h-[400px]" label="Loading alerts…" />
    );
  }

  if (rulesError) {
    return <PageErrorState title="Alert rules could not be loaded" description={rulesError} reset={() => void fetchAlerts()} />;
  }

  return (
    <div className="mx-auto max-w-screen-xl space-y-5 p-4 sm:p-5">
      {/* Header */}
      <PageHeader icon={Target} title="Alerts" subtitle="Automated notifications for CRM events"
        actions={<Button size="sm" className="gap-1.5"
          onClick={() => { setEditId(null); resetForm(); setShowCreate(true); }}>
          <Plus className="h-3.5 w-3.5" /> Create Alert
        </Button>}
      />

      {tab === "history" && historyError && <ErrorAlert variant="destructive"><AlertTitle>Alert history could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{historyError}</span><Button variant="outline" size="sm" onClick={() => void fetchLogs()}>Try again</Button></AlertDescription></ErrorAlert>}

      {/* Tabs */}
      <div className="flex items-center gap-1 p-0.5 bg-muted/50 rounded-lg border border-border/40 w-fit">
        {[
          { key: "rules" as const, label: "Alert Rules", icon: Target },
          { key: "history" as const, label: "History", icon: History },
        ].map((t) => (
          <button
            key={t.key}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
              tab === t.key
                ? "bg-background text-foreground shadow-sm border border-border/40"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <t.icon className="h-3 w-3" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row"><Input type="search" aria-label="Search alerts" value={search} onChange={event=>setSearch(event.target.value)} placeholder={tab==='history' ? 'Search recent alert history…' : 'Search alert rules…'} className="sm:max-w-md"/>{tab==='history' && <select aria-label="Filter alert history by rule" value={historyAlert} onChange={event=>setHistoryAlert(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All alert rules</option>{alerts.map(alert=><option key={alert.id} value={alert.id}>{alert.name}</option>)}</select>}</div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {tab === "rules" ? (
          <motion.div key="rules" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border/40 rounded-xl text-center">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                  <AlertCircle className="h-4 w-4 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium mb-1">No Alert Rules</p>
                <p className="text-xs text-muted-foreground mb-4 max-w-xs">
                  Create rules to get notified when CRM events happen.
                </p>
                <Button size="sm" className="h-7 text-xs rounded-lg" onClick={() => { resetForm(); setShowCreate(true); }}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Create Alert
                </Button>
              </div>
            ) : (
              visibleAlerts.map((alert, i) => (
                <motion.div key={alert.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.02 }}>
                  <Card className={cn(
                    "border border-border/50 bg-card hover:border-border hover:shadow-sm transition-all rounded-xl",
                    !alert.enabled && "opacity-55"
                  )}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1.5">
                            <h3 className="text-sm font-medium truncate">{alert.name}</h3>
                            <Badge className={cn(
                              "text-[10px] font-medium px-1.5 py-0 h-4 rounded-md border",
                              alert.enabled
                                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                                : "bg-muted text-muted-foreground border-border/40"
                            )}>
                              {alert.enabled ? "Active" : "Paused"}
                            </Badge>
                            <Badge className="text-[10px] font-medium px-1.5 py-0 h-4 rounded-md bg-amber-500/10 text-amber-600 border border-amber-500/20">
                              {EVENT_TYPES.find((e) => e.value === alert.eventType)?.label || alert.eventType}
                            </Badge>
                            {(alert.conditions as Record<string, string>)?.stage && (
                              <Badge className="text-[10px] font-medium px-1.5 py-0 h-4 rounded-md bg-indigo-500/10 text-indigo-600 border border-indigo-500/20">
                                Stage: {stages.find(stage => stage.key === (alert.conditions as Record<string, string>).stage)?.label || (alert.conditions as Record<string, string>).stage}
                              </Badge>
                            )}
                          </div>
                          {alert.description && (
                            <p className="text-xs text-muted-foreground truncate mb-1.5">{alert.description}</p>
                          )}
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            {alert.notifyUser && (
                              <span className="flex items-center gap-1">
                                <Bell className="h-3 w-3" /> Notify me
                              </span>
                            )}
                            {alert.notifyContact && (
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" /> Notify contact
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`History for ${alert.name}`} onClick={()=>{setHistoryAlert(String(alert.id));setSearch('');setTab('history');}}><History className="h-3.5 w-3.5"/></Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                            disabled={pendingIds.includes(alert.id)} aria-label={`${alert.enabled ? "Pause" : "Enable"} ${alert.name}`} onClick={() => handleToggle(alert.id, !alert.enabled)}
                            title={alert.enabled ? "Pause" : "Enable"}>
                            {alert.enabled
                              ? <Power className="h-3.5 w-3.5 text-emerald-500" />
                              : <PowerOff className="h-3.5 w-3.5" />}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                            aria-label={`Edit ${alert.name}`} onClick={() => openEdit(alert)}>
                            <Edit className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20"
                            aria-label={`Delete ${alert.name}`} onClick={() => handleDelete(alert.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            )}
          </motion.div>
        ) : (
          <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
            {historyLoading ? <LoadingState size="section" label="Loading alert history…" /> : historyError ? null : logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border/40 rounded-xl text-center">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                  <History className="h-4 w-4 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium mb-1">No Alert History</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Alert triggers will appear here once your rules match CRM events.
                </p>
              </div>
            ) : (
              visibleLogs.map((log, i) => (
                <motion.div key={log.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.02 }}>
                  <Card className="border border-border/50 bg-card hover:border-border transition-all rounded-xl">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h4 className="text-sm font-medium">{log.alertName}</h4>
                            <Badge className="text-[10px] font-medium px-1.5 py-0 h-4 rounded-md bg-amber-500/10 text-amber-600 border border-amber-500/20">
                              {EVENT_TYPES.find((e) => e.value === log.eventType)?.label || log.eventType}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mb-1">
                            Contact: {log.contactId ? <Link href={`/dashboard/crm/contacts/${log.contactId}?tab=activity`} className="font-medium text-primary hover:underline">{log.contactName || 'Open contact'}</Link> : <span>Workspace event</span>}
                            {(log.eventData as Record<string, string>)?.oldStatus && (
                              <> &middot; {stages.find(stage=>stage.key===(log.eventData as Record<string,string>).oldStatus)?.label || (log.eventData as Record<string,string>).oldStatus} &rarr; {stages.find(stage=>stage.key===(log.eventData as Record<string,string>).newStatus)?.label || (log.eventData as Record<string,string>).newStatus}</>
                            )}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{new Date(log.createdAt).toLocaleString()}</span>
                            {log.notifiedUser && <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Notified me</Badge>}
                            {log.notifiedContact && <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Notified contact</Badge>}
                          </div>
                          {!log.notifiedUser && !log.notifiedContact && <p className="mt-2 text-xs leading-5 text-muted-foreground">Matched event; no successful notification was recorded. Review this rule’s notification settings and sending connection.</p>}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {(tab==='rules' && alerts.length>0 && !visibleAlerts.length || tab==='history' && !historyLoading && !historyError && logs.length>0 && !visibleLogs.length) && <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No results match your search.</p>}
      {tab==='history' && !historyLoading && !historyError && logs.length>0 && <p className="text-xs text-muted-foreground">Showing the 50 most recent triggers for {historyAlert==='all' ? 'all alert rules' : 'this alert rule'}.</p>}

      {/* Create/Edit Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open && !saving && confirmLeave()) { setShowCreate(false); setEditId(null); } }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto border-border p-6 shadow-lg sm:max-w-md">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              {editId ? "Edit Alert Rule" : "Create Alert Rule"}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Configure when and how you want to be notified.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="alerts-alert-name" className="text-xs font-medium text-muted-foreground">Alert Name *</Label>
              <Input id="alerts-alert-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Notify on proposal sent"
                className="h-9 rounded-lg text-sm border-border/60" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="alerts-description" className="text-xs font-medium text-muted-foreground">Description</Label>
              <Textarea id="alerts-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional..." rows={2}
                className="rounded-lg text-sm border-border/60 resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Event Type *</Label>
              <Select value={form.eventType} onValueChange={(val) => setForm({ ...form, eventType: val, stage: "any" })}>
                <SelectTrigger aria-label="Event Type *" className="h-9 rounded-lg text-xs border-border/60">
                  <SelectValue placeholder="Select event" />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-border/60">
                  {EVENT_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsStage && (
              <div className="space-y-1.5">
                <Label htmlFor="alert-stage" className="text-xs font-medium text-muted-foreground">
                  {form.eventType === "status_changed_to" ? "When Status Changes To" : "When Status Changes From"}
                </Label>
                <Select value={form.stage} onValueChange={(val) => setForm({ ...form, stage: val })}>
                  <SelectTrigger id="alert-stage" className="h-9 rounded-lg text-xs border-border/60">
                    <SelectValue placeholder="Any stage" />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl border-border/60">
                    <SelectItem value="any">Any Stage</SelectItem>
                    {pipelineStages.map((s) => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2 pt-1">
              <Label className="text-xs font-medium text-muted-foreground">Notifications</Label>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-2.5 bg-muted/30 rounded-lg border border-border/40">
                  <div className="flex items-center gap-2">
                    <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">Email me when triggered</span>
                  </div>
                  <Switch aria-label="Email me when triggered" checked={form.notifyUser} onCheckedChange={(val) => setForm({ ...form, notifyUser: val })} />
                </div>
                <div className="flex items-center justify-between p-2.5 bg-muted/30 rounded-lg border border-border/40">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">Also email the contact</span>
                  </div>
                  <Switch aria-label="Also email the contact" checked={form.notifyContact} onCheckedChange={(val) => setForm({ ...form, notifyContact: val })} />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-5 gap-2">
            <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60"
              disabled={saving} onClick={() => { if (confirmLeave()) { setShowCreate(false); setEditId(null); } }}>Cancel</Button>
            <Button size="sm" className="h-8 rounded-lg text-xs px-5" onClick={handleSave} loading={saving}>
              {editId ? "Save Changes" : "Create Alert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
