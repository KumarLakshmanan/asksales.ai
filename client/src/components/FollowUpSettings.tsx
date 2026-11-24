
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, FileText, Save, Sparkles, Workflow, ShieldCheck } from "lucide-react";
import api from "@/lib/api";
import { TemplateSelector } from "@/components/outreach/TemplateSelector";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { FollowUpTemplateDialog } from "@/components/follow-ups/FollowUpTemplates";
import { followUpRequest } from '@/lib/follow-up-request';
import type { ChannelFollowUpSettings } from '@/hooks/use-channel-follow-up-settings';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import type { FollowUpChannel } from "../../../shared/followUpChannels";
import type { FollowUpStepId } from "../../../shared/followUpSettings";

type DelayUnit = "minutes" | "hours" | "days";
const MIN_MINUTE_DELAY = 1;
const MAX_STEPS = 10;

interface FollowUpStep {
  id: FollowUpStepId;
  enabled?: boolean;
  delayValue: number;
  delayUnit: DelayUnit;
  delayHours: number;
  templateId: number | null;
  templateName: string;
}

export interface FollowUpSaveConfirmation { revision?: string; fenced?: boolean; advanced?: boolean }
export type FollowUpSaveOutcome = 'saved' | 'rejected' | 'uncertain';

interface FollowUpSettingsProps {
  integrationKey?: FollowUpChannel;
  className?: string;
  onSaved?: () => void;
  saveDisabled?: boolean;
  initialAttempt?: ChannelFollowUpSettings;
  onSaveStart?: (settings: ChannelFollowUpSettings) => ((outcome: FollowUpSaveOutcome, confirmation?: FollowUpSaveConfirmation) => void) | false;
  /** Lets the page hold controls (such as the channel tabs) while settings load. */
  onLoadingChange?: (loading: boolean) => void;
}

export function FollowUpSettings(props: FollowUpSettingsProps) {
  const scope = useOutreachDraftScope();
  return <FollowUpSettingsForm key={`${scope}:${props.integrationKey ?? 'email'}`} {...props} />;
}

function FollowUpSettingsForm({ integrationKey = "email", className, onSaved, onSaveStart, saveDisabled, initialAttempt, onLoadingChange }: FollowUpSettingsProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  useEffect(() => { onLoadingChange?.(loading); }, [loading, onLoadingChange]);
  // Release the page's controls if this form unmounts mid-load.
  useEffect(() => () => onLoadingChange?.(false), [onLoadingChange]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState<string>();
  const [saveError, setSaveError] = useState("");
  const [enableAutoFollowUp, setEnableAutoFollowUp] = useState(true);
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [activeStepId, setActiveStepId] = useState<FollowUpStepId | null>(null);
  const templateCreateButton = useRef<HTMLElement | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [followUpSteps, setFollowUpSteps] = useState<FollowUpStep[]>([
    { id: 1, delayValue: 1, delayUnit: "days", delayHours: 24, templateId: null, templateName: "" },
    { id: 2, delayValue: 3, delayUnit: "days", delayHours: 72, templateId: null, templateName: "" },
  ]);
  const isConversationScopedSocial = ["instagram", "facebook", "whatsapp"].includes(integrationKey);
  const loadVersion = useRef(0);
  const savePending = useRef(false);
  const mounted = useRef(true);
  const recoveredAttempt = useRef(initialAttempt);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const computeDelayHours = (value: number, unit: DelayUnit): number => {
    switch (unit) {
      case "minutes": return value / 60;
      case "hours": return value;
      case "days": return value * 24;
    }
  };

  const parseDelayHoursToValueUnit = (hours: number): { value: number; unit: DelayUnit } => {
    if (hours >= 24 && hours % 24 === 0) return { value: hours / 24, unit: "days" };
    if (hours >= 1 && Number.isInteger(hours)) return { value: hours, unit: "hours" };
    return { value: Math.max(MIN_MINUTE_DELAY, Math.round(hours * 60)), unit: "minutes" };
  };

  const getMinDelayForUnit = (unit: DelayUnit): number => {
    if (unit === "minutes") return MIN_MINUTE_DELAY;
    return 1;
  };

  const getMinValueForStep = (unit: DelayUnit, _prevHours: number): number => {
    return getMinDelayForUnit(unit);
  };

  const loadData = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      setLoading(true);
      setLoadError(null);
      const settingsRes = await followUpRequest(signal => api.get<{ enableAutoFollowUp?: boolean; followUpSteps?: FollowUpStep[]; revision?: string }>(`/api/settings/integrations/${integrationKey}/follow-ups`, { signal }));
      if (version !== loadVersion.current) return;
      if (typeof settingsRes?.enableAutoFollowUp !== 'boolean' || !Array.isArray(settingsRes.followUpSteps) || !settingsRes.followUpSteps.length) {
        throw new Error('Saved follow-up settings could not be read. Try again.');
      }
      const recovered = recoveredAttempt.current;
      recoveredAttempt.current = undefined;
      const savedSteps = settingsRes.followUpSteps;
      const draft = recovered ?? settingsRes;
      setRevision(settingsRes.revision);
      setSaveError("");
      if (settingsRes.enableAutoFollowUp !== undefined) {
        setEnableAutoFollowUp(draft.enableAutoFollowUp ?? settingsRes.enableAutoFollowUp);
      }
      if (savedSteps.length > 0) {
        setFollowUpSteps((draft.followUpSteps || savedSteps).map(step => {
          const savedStep = savedSteps.find(saved => String(saved.id) === String(step.id) && saved.templateId === step.templateId);
          const templateName = recovered ? savedStep?.templateName ?? step.templateName : step.templateName;
          const enabled = step.enabled ?? savedStep?.enabled ?? true;
          if (typeof step.delayValue === 'number' && ['minutes', 'hours', 'days'].includes(step.delayUnit)) return { ...step, enabled, templateName, delayHours: computeDelayHours(step.delayValue, step.delayUnit) };
          const { value, unit } = parseDelayHoursToValueUnit('delayHours' in step && typeof step.delayHours === 'number' ? step.delayHours : 24);
          return { ...step, enabled, templateName, delayValue: value, delayUnit: unit, delayHours: computeDelayHours(value, unit) };
        }));
      }
    } catch (error) {
      if (version !== loadVersion.current) return;
      setLoadError(error instanceof Error ? error.message : "Follow-up settings could not be loaded.");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [integrationKey]);

  useEffect(() => {
    loadData();
    return () => { loadVersion.current += 1; };
  }, [loadData]);

  const validationErrors = followUpSteps.map((step, index) => {
    const hours = computeDelayHours(step.delayValue, step.delayUnit);
    if (!Number.isInteger(step.delayValue) || step.delayValue < (step.enabled === false ? 0 : 1) || hours > 8760) {
      return `Step ${index + 1}: use a whole-number delay from 1 minute to 365 days.`;
    }
    if (step.enabled === false) return '';
    const previousEnabledIndex = followUpSteps.slice(0, index).findLastIndex(previous => previous.enabled !== false);
    if (previousEnabledIndex >= 0 && hours <= computeDelayHours(followUpSteps[previousEnabledIndex].delayValue, followUpSteps[previousEnabledIndex].delayUnit)) {
      return `Step ${index + 1}: choose a delay later than step ${previousEnabledIndex + 1}.`;
    }
    return '';
  }).filter(Boolean);
  if (followUpSteps.length > MAX_STEPS) validationErrors.push('Use no more than 10 follow-up steps.');

  const handleSave = async () => {
    if (saveDisabled || savePending.current || loading || loadError || validationErrors.length) return;
    const settings = { enableAutoFollowUp, followUpSteps: followUpSteps.map(step => ({
      ...step, delayHours: computeDelayHours(step.delayValue, step.delayUnit),
    })) };
    const settled = onSaveStart?.({ ...settings, revision });
    if (settled === false) return;
    let outcome: FollowUpSaveOutcome = 'uncertain';
    let confirmation: FollowUpSaveConfirmation | undefined;
    try {
      savePending.current = true;
      setSaving(true);
      setSaveError("");
      const saved = await followUpRequest(signal => api.put<{ success?: boolean; revision?: string; fenced?: boolean; advanced?: boolean }>(`/api/settings/integrations/${integrationKey}/follow-ups`, {
        ...settings, expectedRevision: revision,
      }, { signal }));
      if (saved?.success !== true) throw new Error('Follow-up save confirmation could not be read. Refresh settings before reviewing outreach.');
      outcome = 'saved'; confirmation = saved;
      if (!mounted.current) return;
      setRevision(saved?.revision);
      onSaved?.();
      toast({
        title: "Settings Saved",
        description: "Follow-up settings updated successfully.",
      });
    } catch (error: unknown) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (status >= 400 && status < 500) outcome = 'rejected';
      if (!mounted.current) return;
      setSaveError((error as Error)?.message || "Failed to save settings");
      toast({
        title: "Error",
        description: (error as Error)?.message || "Failed to save settings",
        variant: "destructive",
      });
    } finally {
      if (typeof settled === 'function') settled(outcome, confirmation);
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const addStep = () => {
    if (followUpSteps.length >= MAX_STEPS) return;
    const newId = crypto.randomUUID();
    const lastStep = followUpSteps[followUpSteps.length - 1];
    const newValue = lastStep ? lastStep.delayValue + (lastStep.delayUnit === "days" ? 3 : lastStep.delayUnit === "hours" ? 24 : 60) : 1;
    const newUnit = lastStep?.delayUnit || "days";
    setFollowUpSteps([
      ...followUpSteps,
      {
        id: newId,
        enabled: true,
        delayValue: newValue,
        delayUnit: newUnit,
        delayHours: computeDelayHours(newValue, newUnit),
        templateId: null,
        templateName: "",
      },
    ]);
  };

  const removeStep = (id: FollowUpStepId) => {
    if (followUpSteps.length <= 1) {
      toast({
        title: "Action Restricted",
        description: "You must have at least one follow-up step",
        variant: "destructive",
      });
      return;
    }
    setFollowUpSteps(followUpSteps.filter(s => s.id !== id));
  };

  const updateStep = (id: FollowUpStepId, updates: Partial<FollowUpStep>) => {
    setFollowUpSteps(previous => previous.map(step =>
      step.id === id ? { ...step, ...updates } : step
    ));
  };

  const openTemplateSelector = (stepId: FollowUpStepId) => {
    setActiveStepId(stepId);
    setTemplateSelectorOpen(true);
  };

  const handleModalTemplateSelect = (template: { id: number; name: string; content: string; source?: string }) => {
    if (activeStepId !== null) {
      updateStep(activeStepId, {
        templateId: template.id,
        templateName: template.name,
      });
    }
  };

  if (loading) {
    // Shaped like the form so the page does not look finished while the
    // saved settings are still loading.
    return (
      <div aria-busy="true" className={cn("w-full space-y-4 overflow-hidden rounded-xl border border-border/40 bg-card/30 p-4 shadow-lg", className)}>
        <LoadingState size="inline" label="Loading follow-up settings…" showLabel />
        <div aria-hidden="true" data-testid="follow-up-settings-skeleton" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-12 w-full rounded-lg" />
          {[0, 1].map((step) => (
            <div key={step} className="grid gap-3 rounded-lg border border-border/40 p-3 sm:grid-cols-[1fr_1fr_2fr]">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <Card className={cn("rounded-xl border border-destructive/30 bg-destructive/5 p-4", className)}>
        <p className="text-sm font-semibold">Follow-up settings could not be loaded</p>
        <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void loadData()}>
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card className={cn("workspace-panel follow-up-settings rounded-lg border border-border bg-card overflow-hidden divide-y divide-border w-full shadow-none", className)}>
      {/* Header Row */}
      <div className="flex flex-col gap-3 p-4 bg-muted/10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="workspace-section-icon">
            <Workflow className="w-3 h-3" />
          </div>
          <span className="text-sm font-semibold">Follow-up sequence</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-background/50 border border-border/40">
             <span className="text-xs font-medium text-muted-foreground">Automatic follow-ups</span>
            <Switch
              aria-label="Enable automatic follow-ups"
              checked={enableAutoFollowUp}
              disabled={saving}
              onCheckedChange={setEnableAutoFollowUp}
              className="data-[state=checked]:bg-primary"
            />
          </div>
          <Button
            size="sm"
            className="min-h-11 px-4 rounded-md font-semibold text-sm gap-2"
            onClick={handleSave}
            loading={saving}
            loadingText="Save Settings"
            disabled={saveDisabled || validationErrors.length > 0}
          >
            <Save className="w-3 h-3" />
            Save Settings
          </Button>
        </div>
      </div>

      <CardContent className="p-4 space-y-3">
        <p id="follow-up-timing" className="workspace-scope-notice text-xs leading-relaxed">
          Each step is timed from the initial message. For example, 1 hour and 1 day send follow-ups 1 hour and 24 hours after that message. Follow-ups do not restart the timer.
        </p>
        {!enableAutoFollowUp && followUpSteps.length > 0 && <Callout tone="warning"><p>Automatic follow-ups are off, so none of these steps will send. Your steps stay saved. Turn on Automatic follow-ups to start them.</p></Callout>}
        {saveError && <Callout tone="danger" actions={<Button variant="outline" size="sm" onClick={() => void loadData()}>Discard edits and reload</Button>}><p>{saveError}</p></Callout>}
        {validationErrors.length > 0 && <Callout tone="danger">{validationErrors.map(error => <p key={error}>{error}</p>)}</Callout>}
        <fieldset disabled={saving} aria-describedby="follow-up-timing" className="min-w-0 space-y-3">
        <legend className="sr-only">Follow-up steps</legend>
        <AnimatePresence mode="popLayout" initial={false}>
          {followUpSteps.map((step, index) => {
            const prevStepHours = followUpSteps.slice(0, index).findLast(previous => previous.enabled !== false)?.delayHours || 0;
            const minValue = step.enabled === false ? 0 : getMinValueForStep(step.delayUnit, prevStepHours);
            const isAI = step.templateId === -1;

            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className={cn(
                  "follow-up-step flex flex-col xl:flex-row items-start xl:items-center gap-4 p-4 rounded-lg border transition-colors",
                  isAI ? "bg-primary/5 border-primary/20" : "bg-card border-border hover:bg-muted/10"
                )}
              >
                {/* Step Marker */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className={cn(
                    "w-6 h-6 rounded flex items-center justify-center text-xs font-semibold border",
                    isAI ? "bg-primary text-primary-foreground border-primary" : "bg-primary/5 text-primary border-primary/20"
                  )}>
                    {index + 1}
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">Step</div>
                  <Switch aria-label={`Enable step ${index + 1}`} checked={step.enabled !== false} onCheckedChange={enabled => updateStep(step.id, { enabled })} />
                </div>

                {/* Delay Settings */}
                <div className="flex flex-col gap-1.5 w-full lg:w-44 shrink-0">
                  <div className="flex bg-background/50 rounded-md border border-border overflow-hidden h-11 w-full">
                    <Input
                      aria-label={`Step ${index + 1} delay`}
                      type="number"
                      value={step.delayValue}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        updateStep(step.id, { delayValue: val, delayHours: computeDelayHours(val, step.delayUnit) });
                      }}
                      min={minValue}
                      className="h-11 min-w-0 flex-1 border-none bg-transparent rounded-none px-2 font-mono text-sm text-center"
                    />
                    <div className="w-px bg-border/40" />
                    <Select
                      value={step.delayUnit}
                      onValueChange={(unit: DelayUnit) => {
                        const nextMin = step.enabled === false ? 0 : getMinValueForStep(unit, prevStepHours);
                        const nextValue = Math.max(nextMin, step.delayValue);
                        updateStep(step.id, { delayUnit: unit, delayValue: nextValue, delayHours: computeDelayHours(nextValue, unit) });
                      }}
                    >
                      <SelectTrigger aria-label={`Step ${index + 1} delay unit`} className="h-11 w-20 shrink-0 border-none bg-transparent rounded-none px-2 text-sm font-medium justify-center [&>svg]:hidden">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="rounded-md border-border/40">
                        <SelectItem value="minutes" className="text-xs font-medium">Min</SelectItem>
                        <SelectItem value="hours" className="text-xs font-medium">Hours</SelectItem>
                        <SelectItem value="days" className="text-xs font-medium">Days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <span className="text-xs text-muted-foreground">after initial message</span>
                </div>

                {/* Content Trigger */}
                <div className="flex-1 min-w-0 flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 w-full">
                  <Button
                    variant="outline"
                    className={cn(
                      "h-11 min-w-0 flex-1 rounded-md text-sm justify-start px-3 truncate border-border font-medium",
                      isAI ? "bg-primary/10 text-primary border-primary/20" : "bg-background/50"
                    )}
                    aria-label={`Choose template for step ${index + 1}`}
                    title={step.templateName || 'Choose template'}
                    onClick={() => openTemplateSelector(step.id)}
                  >
                    {step.templateId && step.templateId !== -1 ? (
                      <div className="flex items-center gap-2 truncate">
                        <FileText className="w-3 h-3 shrink-0 text-primary/60" />
                        <span className="truncate">{step.templateName}</span>
                      </div>
                    ) : isAI ? (
                      <div className="flex items-center gap-2 truncate">
                        <Sparkles className="w-3 h-3 shrink-0 text-primary" />
                        <span className="font-semibold text-xs">AI writes this message</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Plus className="w-3 h-3" />
                        <span className="font-medium">Choose template</span>
                      </div>
                    )}
                  </Button>

                  <div className="flex items-center justify-end gap-1">
                    <Button variant="outline" size="icon" className="h-11 w-11" aria-label={`Create template for step ${index + 1}`} onClick={event => { templateCreateButton.current = event.currentTarget; setActiveStepId(step.id); setCreatingTemplate(true); }}><Plus className="h-3.5 w-3.5" /></Button>
                    <Button
                      variant={isAI ? "default" : "outline"}
                      size="icon"
                      aria-label={`Auto-generate step ${index + 1}`}
                      aria-pressed={isAI}
                      onClick={() => updateStep(step.id, {
                        templateId: isAI ? null : -1,
                        templateName: isAI ? "" : "Auto-generate"
                      })}
                      className={cn(
                        "h-11 w-11 rounded-md shrink-0 transition-colors",
                        isAI
                          ? "bg-primary text-white border-none shadow-sm"
                          : "bg-background text-muted-foreground border-border/40"
                      )}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </Button>

                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove step ${index + 1}`}
                      onClick={() => removeStep(step.id)}
                      disabled={followUpSteps.length <= 1}
                      className="h-11 w-11 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Add Step Action */}
        <Button
          variant="ghost"
          onClick={addStep}
          disabled={followUpSteps.length >= MAX_STEPS}
          className="w-full h-11 rounded-lg text-sm font-medium text-muted-foreground hover:text-primary hover:bg-primary/5 border border-dashed border-border transition-colors"
        >
          <div className="flex items-center justify-center gap-2">
            <Plus className="w-3 h-3" />
            {followUpSteps.length >= MAX_STEPS ? '10-step limit reached' : 'Add Follow-Up Step'}
          </div>
        </Button>
        </fieldset>
      </CardContent>

      <div className="p-4 bg-muted/20 flex items-start gap-2">
        <ShieldCheck className="w-3 h-3 text-primary/40" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {isConversationScopedSocial
            ? "These channel defaults apply to reviewed outbound outreach. A published assistant’s sequence takes precedence for its own support reply. A new outbound outreach or support reply starts a new sequence; follow-ups keep that sequence’s original timer. A customer reply or human takeover stops pending follow-ups. After the final unanswered follow-up, this chat closes; the next customer message starts a new chat and playbook. Previous chats remain in CRM."
            : "These channel defaults apply to reviewed outbound outreach. A published assistant’s sequence takes precedence for its own support reply. Each period is measured from the original outbound message. Any customer reply cancels all remaining follow-ups."}
        </p>
      </div>

      <FollowUpTemplateDialog returnFocusRef={templateCreateButton} channel={integrationKey} open={creatingTemplate} onOpenChange={setCreatingTemplate} onCreated={handleModalTemplateSelect} />
      <TemplateSelector
        open={templateSelectorOpen}
        onOpenChange={setTemplateSelectorOpen}
        channel={integrationKey}
        onSelect={handleModalTemplateSelect}
        selectionMode="follow-up"
      />
    </Card>
  );
}
