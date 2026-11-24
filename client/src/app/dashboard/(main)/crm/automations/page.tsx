"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import {useRouter} from "next/navigation";
import Link from "next/link";
import {selectedBusinessProfileId,subscribeBusinessProfile} from "@/lib/business-profile";
import {useCrmAutomationRefresh} from "@/hooks/use-crm-automation-refresh";
import { useCrmConfiguration } from "@/hooks/use-crm-configuration";
import {AUTOMATION_TRIGGERS,AUTOMATION_ACTIONS,type AutomationDefinition} from "@/lib/crm-automations";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { crmRunHelp } from "@/lib/crm-run-help";
import {
  Plus, Zap, Trash2, Edit, Activity, History, Bot, Layers
} from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";

interface Automation {
  id: number;
  name: string;
  definition?: AutomationDefinition;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  action: string;
  actionConfig: Record<string, unknown>;
  conditions: Record<string, unknown>;
  isActive: boolean;
  executionCount: number;
  lastRunAt: string | null;
  createdAt: string;
}

interface AutomationLog {
  id: number;
  automationId: number;
  automationName: string;
  triggerEvent: string;
  action: string;
  contactId: number;
  contactName: string;
  success: boolean;
  errorMessage: string | null;
  executedAt: string;
  runId?: number | null;
  status?: string;
}

const TRIGGER_EVENTS = AUTOMATION_TRIGGERS.map(item=>({value:item.type,label:item.label}));
const ACTIONS = AUTOMATION_ACTIONS.map(item=>({value:item.type,label:item.label}));

export default function CRMAutomationsPage() {
  const { toast } = useToast();
  const router=useRouter();
  const { stages } = useCrmConfiguration();
  const stageLabel = (value: unknown) => {
    if (!value) return "Any stage";
    const key = String(value);
    return stages.find(stage => stage.key === key)?.label || key.replaceAll("_", " ");
  };
  const profileId=useSyncExternalStore(subscribeBusinessProfile,selectedBusinessProfileId,()=>null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [logs, setLogs] = useState<AutomationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [automationsError, setAutomationsError] = useState<string | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [tab, setTab] = useState<"automations" | "logs">("automations");
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [logsLoading,setLogsLoading]=useState(false);
  const requestVersion=useRef(0);
  const logsRequestVersion=useRef(0);
  const dataInFlight=useRef(0),logsInFlight=useRef(0);
  const fetchLogs=useCallback(async()=>{
    const version=++logsRequestVersion.current,requestedProfile=selectedBusinessProfileId();logsInFlight.current=version;setLogsLoading(true);setLogsError(null);
    try {const result=await api.get<AutomationLog[]>('/api/crm/automations/logs');if(version===logsRequestVersion.current && selectedBusinessProfileId()===requestedProfile) setLogs(result || []);}
    catch(error){if(version===logsRequestVersion.current && selectedBusinessProfileId()===requestedProfile) setLogsError(error instanceof Error ? error.message : 'Failed to load automation history');}
    finally{if(version===logsRequestVersion.current && selectedBusinessProfileId()===requestedProfile) setLogsLoading(false);if(logsInFlight.current===version) logsInFlight.current=0;}
  },[]);

  const fetchData = useCallback(async (background=false) => {
    const version=++requestVersion.current,requestedProfile=selectedBusinessProfileId();
    dataInFlight.current=version;
    try {
      if (!background) setLoading(true);
      setAutomationsError(null);
      const autoResult = await api.get<Automation[]>("/api/crm/automations");
      if (version!==requestVersion.current || selectedBusinessProfileId()!==requestedProfile) return;
      setAutomations(autoResult || []);
    } catch(error){
      if (version===requestVersion.current && selectedBusinessProfileId()===requestedProfile) setAutomationsError(error instanceof Error ? error.message : 'Failed to load automation rules');
    } finally {
      if (version===requestVersion.current && selectedBusinessProfileId()===requestedProfile) setLoading(false);
      if (dataInFlight.current===version) dataInFlight.current=0;
    }
  }, []);

  useEffect(() => {setAutomations([]);setLogs([]);setSearch('');setStatusFilter('all');void fetchData();}, [fetchData,profileId]);
  useEffect(()=>{if(tab==='logs') void fetchLogs();},[tab,fetchLogs,profileId]);
  // Automatic refreshes skip a read still running so a slow first load is not
  // discarded and restarted.
  useCrmAutomationRefresh(async()=>{if(!dataInFlight.current) await fetchData(true);if(tab==='logs' && !logsInFlight.current) await fetchLogs();});

  const toggleActive = useCallback(async (auto: Automation) => {
    if (pendingIds.includes(auto.id)) return;
    const requestedProfile=selectedBusinessProfileId();
    setPendingIds(ids => [...ids, auto.id]);
    try {
      await api.put(`/api/crm/automations/${auto.id}`, { isActive: !auto.isActive });
      if(selectedBusinessProfileId()!==requestedProfile) return;
      setAutomations((prev) => prev.map((a) => (a.id === auto.id ? { ...a, isActive: !a.isActive } : a)));
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to update status", variant: "destructive" });
    } finally { setPendingIds(ids => ids.filter(id => id !== auto.id)); }
  }, [toast, pendingIds]);

  const deleteAutomation = useCallback(async (id: number) => {
    if (!window.confirm("Delete this automation and stop all future runs?")) return;
    const requestedProfile=selectedBusinessProfileId();
    try {
      await api.delete(`/api/crm/automations/${id}`);
      if(selectedBusinessProfileId()!==requestedProfile) return;
      setAutomations((prev) => prev.filter((a) => a.id !== id));
      toast({ title: "Automation deleted" });
    } catch {
      toast({ title: "Error", description: "Failed to delete", variant: "destructive" });
    }
  }, [toast]);

  const openEdit = (auto: Automation) => router.push(`/dashboard/crm/automations/${auto.id}`);

  if (loading) {
    return <PageLoadingState label="Loading CRM automations…" />;
  }

  if (automationsError && !automations.length && tab==='automations') {
    return <PageErrorState title="CRM automations could not be loaded" description="Rules and execution history are currently unavailable." reset={() => void fetchData()} />;
  }
  const normalizedSearch=search.trim().toLocaleLowerCase();
  const visibleAutomations=automations.filter(auto=>(statusFilter==='all' || (statusFilter==='active' ? auto.isActive : !auto.isActive)) && `${auto.name} ${auto.triggerType} ${auto.action}`.toLocaleLowerCase().includes(normalizedSearch));
  const visibleLogs=logs.filter(log=>(statusFilter==='all' || (log.status || (log.success ? 'success' : 'failed'))===statusFilter) && `${log.automationName} ${log.contactName} ${log.triggerEvent}`.toLocaleLowerCase().includes(normalizedSearch));

  return (
    <div className="p-5 space-y-5 max-w-screen-xl mx-auto">
      <PageHeader
        icon={Zap}
        title="Automations"
        subtitle="Automate repetitive tasks in your CRM pipeline"
        actions={<Button size="sm" className="h-8 text-xs rounded-lg px-4 gap-1.5"
          onClick={() => router.push("/dashboard/crm/automations/new")}>
          <Plus className="h-3.5 w-3.5" /> Create automation
        </Button>}
      />

      {/* Tabs */}
      <div className="flex items-center gap-1 p-0.5 bg-muted/50 rounded-lg border border-border/40 w-fit">
        {[
          { key: "automations" as const, label: `Rules (${automations.length})`, icon: Bot },
          { key: "logs" as const, label: `Logs (${logs.length})`, icon: History },
        ].map((t) => (
          <button key={t.key} aria-pressed={tab === t.key} onClick={() => {setTab(t.key);setStatusFilter('all');}}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
              tab === t.key
                ? "bg-background text-foreground shadow-sm border border-border/40"
                : "text-muted-foreground hover:text-foreground"
            )}>
            <t.icon className="h-3 w-3" />{t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row"><Input type="search" aria-label="Search automations" value={search} onChange={event=>setSearch(event.target.value)} placeholder={tab==='logs' ? 'Search recent history by rule or contact…' : 'Search automation rules…'} className="sm:max-w-md"/><select aria-label="Filter automations by status" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All statuses</option>{(tab==='automations' ? ['active','paused'] : ['success','failed','retry','uncertain','cancelled']).map(value=><option key={value} value={value}>{value}</option>)}</select></div>

      {tab === "automations" && automationsError && (
        <PageErrorState title="Automation rules could not be loaded" description={automationsError} reset={() => void fetchData()} />
      )}
      {tab === "logs" && logsError && (
        <PageErrorState title="Automation history could not be loaded" description={logsError} reset={() => void fetchLogs()} />
      )}

      <AnimatePresence mode="wait">
        {tab === "automations" && !automationsError ? (
          <motion.div key="automations" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {automations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border/40 rounded-xl text-center">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                  <Bot className="h-4 w-4 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium mb-1">No Automations</p>
                <p className="text-xs text-muted-foreground mb-4 max-w-xs">Create rules to automate CRM tasks when events happen.</p>
                <Button size="sm" className="h-7 text-xs rounded-lg gap-1.5" onClick={() => router.push("/dashboard/crm/automations/new")}>
                  <Plus className="h-3.5 w-3.5" /> New Automation
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {visibleAutomations.map((auto, i) => (
                  <motion.div key={auto.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}>
                    <Card className={cn(
                      "border border-border/50 rounded-xl bg-card hover:border-border hover:shadow-sm transition-all overflow-hidden",
                      !auto.isActive && "opacity-60"
                    )}>
                      <div className={cn("h-0.5 w-full", auto.isActive ? "bg-primary" : "bg-muted")} />
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                              auto.isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                              <Zap className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{auto.name}</p>
                              <span className={cn(
                                "text-[10px] font-medium",
                                auto.isActive ? "text-emerald-600" : "text-muted-foreground"
                              )}>
                                {auto.isActive ? "Active" : "Paused"}
                              </span>
                            </div>
                          </div>
                          <Switch aria-label={`Enable ${auto.name}`} disabled={pendingIds.includes(auto.id)} checked={auto.isActive} onCheckedChange={() => toggleActive(auto)}
                            className="shrink-0 mt-0.5" />
                        </div>

                        <div className="space-y-1.5 mb-3">
                          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30 border border-border/30">
                            <Activity className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                            <span className="text-[10px] text-muted-foreground mr-1">When:</span>
                            <Badge variant="outline" className="text-[10px] font-medium px-1.5 py-0 h-4 rounded-md border-primary/20 bg-primary/5 text-primary ml-auto">
                              {TRIGGER_EVENTS.find(t => t.value === auto.triggerType)?.label || auto.triggerType}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30 border border-border/30">
                            <Layers className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                            <span className="text-[10px] text-muted-foreground mr-1">Do:</span>
                            <Badge variant="secondary" className="text-[10px] font-medium px-1.5 py-0 h-4 rounded-md ml-auto">
                              {auto.definition && auto.definition.actions.length > 1 ? `${auto.definition.actions.length} ordered actions` : ACTIONS.find(a => a.value === auto.action)?.label || auto.action}
                            </Badge>
                          </div>
                        </div>

                        <p className="mb-3 text-xs text-muted-foreground">{auto.triggerType==='pipeline_status_changed' || auto.triggerConfig?.fromStatus || auto.triggerConfig?.toStatus ? <>{stageLabel(auto.triggerConfig?.fromStatus)} → {stageLabel(auto.triggerConfig?.toStatus)}</> : auto.definition?.conditions.rules.length ? `${auto.definition.conditions.rules.length} condition${auto.definition.conditions.rules.length===1 ? '' : 's'} checked before actions` : 'Runs when the selected event occurs'}</p>
                        <div className="flex items-center justify-between pt-3 border-t border-border/30">
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground">{auto.executionCount}</span> runs
                            {auto.lastRunAt && (
                              <>
                                <span>·</span>
                                <span>last {new Date(auto.lastRunAt).toLocaleDateString()}</span>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Run history for ${auto.name}`} onClick={()=>router.push(`/dashboard/crm/automations/${auto.id}/runs`)}><History className="h-3.5 w-3.5"/></Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
                              aria-label={`Edit ${auto.name}`} onClick={() => openEdit(auto)}>
                              <Edit className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20"
                              aria-label={`Delete ${auto.name}`} onClick={() => deleteAutomation(auto.id)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        ) : tab === "logs" && !logsError ? (
          <motion.div key="logs" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {logsLoading ? <LoadingState size="section" label="Loading automation history…" /> : logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border/40 rounded-xl text-center">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                  <History className="h-4 w-4 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium">No Automation Logs</p>
              </div>
            ) : (
              <Card className="border border-border/50 rounded-xl shadow-none overflow-hidden">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/30">
                      <TableRow className="hover:bg-transparent border-border/40">
                        <TableHead className="text-xs font-semibold h-9 px-4">Automation</TableHead>
                        <TableHead className="text-xs font-semibold h-9 px-4">Contact</TableHead>
                        <TableHead className="text-xs font-semibold h-9 px-4 text-center">Status</TableHead>
                        <TableHead className="text-xs font-semibold h-9 px-4 text-right">Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleLogs.map((log) => (
                        <TableRow key={log.id} className="hover:bg-muted/20 border-border/30 h-10">
                          <TableCell className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <div className={cn("p-1 rounded-md", log.success ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500")}>
                                <Zap className="h-3 w-3" />
                              </div>
                              <span className="text-xs font-medium">{log.automationName}</span>
                              {log.runId && <Button variant="link" className="h-auto p-0 text-xs" onClick={()=>router.push(`/dashboard/crm/automations/${log.automationId}/runs?run=${log.runId}`)}>Steps</Button>}
                            </div>
                          </TableCell>
                          <TableCell className="px-4 py-2 text-xs text-muted-foreground">{log.contactId ? <Link className="text-primary hover:underline" href={`/dashboard/crm/contacts/${log.contactId}?tab=activity`}>{log.contactName || 'Open contact'}</Link> : log.contactName || 'Workspace event'}</TableCell>
                          <TableCell className="px-4 py-2 text-center">
                            <Badge className={cn(
                              "text-[10px] font-medium px-1.5 py-0 h-4 rounded-md border-none",
                              log.success ? "bg-emerald-500/10 text-emerald-600" : "bg-rose-500/10 text-rose-600"
                            )}>
                              {log.status || (log.success ? "Success" : "Failed")}
                            </Badge>
                            {log.errorMessage && (
                              <p className="text-[10px] text-rose-500 mt-0.5">{crmRunHelp(log.errorMessage,log.status).title}. {log.runId ? 'Open Steps for guidance.' : 'Review and test the rule.'}</p>
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-2 text-right">
                            <span className="text-xs text-muted-foreground">
                              {new Date(log.executedAt).toLocaleString()}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {(tab==='automations' && automations.length>0 && !visibleAutomations.length || tab==='logs' && !logsLoading && logs.length>0 && !visibleLogs.length) && <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No results match these filters.</p>}
      {tab==='logs' && logs.length>0 && <p className="text-xs text-muted-foreground">Showing recent recorded runs. Open a rule’s run history to load older runs and delivery steps.</p>}

    </div>
  );
}
