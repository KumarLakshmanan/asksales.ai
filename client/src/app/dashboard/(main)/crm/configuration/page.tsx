"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Save, Settings2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { PageShell } from '@/components/ui/page-shell';
import { WorkspaceSettingsScope } from '@/components/settings/WorkspaceSettingsScope';
import { CrmStageEditor } from '@/components/crm/CrmStageEditor';
import { PlatformMultiSelect } from '@/components/crm/PlatformMultiSelect';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { CRM_CONFIGURATION_API, CRM_DATE_RANGES, DEFAULT_CRM_CONFIGURATION, crmConfigurationIssues, crmPlatformLabel, crmDateRangeLabel, isCrmConfiguration, type CrmConfiguration, type CrmPreferences } from '@/lib/crm-configuration';

const steps = [
  { title: 'Stages', description: 'Configure your lead stages' },
  { title: 'Preferences', description: 'Set your defaults' },
  { title: 'Confirm', description: 'Review and save' },
];

function recoveryOwnerKey(): string {
  try { const user = JSON.parse(localStorage.getItem('user') || 'null'); return String(user?.id || user?.user?.id || 'anonymous'); }
  catch { return 'anonymous'; }
}

export default function CRMConfigurationPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { configuration, loading, error: loadError, reload } = useCrmConfiguration();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const recoveryKey = `crm-configuration-draft:${profileId || 'default'}:${typeof window !== 'undefined' ? recoveryOwnerKey() : 'anonymous'}`;
  const [draft, setDraft] = useState<CrmConfiguration | null>(null);
  const [recovered, setRecovered] = useState<CrmConfiguration | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = !!draft && !!configuration && JSON.stringify(draft) !== JSON.stringify(configuration);
  const { confirmLeave, clearGuard } = useUnsavedChanges(dirty);

  const clearRecovery = () => {
    setRecovered(null);
    try { sessionStorage.removeItem(recoveryKey); } catch { /* Saving remains available without browser storage. */ }
  };

  useEffect(() => {
    if (configuration) {
      setDraft(structuredClone(configuration));
      setStep(0);
      setFurthestStep(0);
      setIssues([]);
      setSaveError(null);
      setRecovered(null);
      setRecoveryNotice('');
      try {
        const raw = sessionStorage.getItem(recoveryKey);
        if (raw && raw.length < 120000) {
          const saved = JSON.parse(raw);
          if (saved.revision === (configuration.revision || JSON.stringify(configuration)) && Date.now() - saved.at < 7 * 86400000 && isCrmConfiguration(saved.value)) setRecovered(saved.value);
          else { sessionStorage.removeItem(recoveryKey); setRecoveryNotice('An older draft was discarded because the saved configuration changed or the draft expired.'); }
        }
      } catch { setRecoveryNotice('Browser draft recovery is unavailable. Save your changes before leaving.'); }
    }
  }, [configuration, recoveryKey]);

  useEffect(() => {
    if (!dirty || !draft || !configuration || recovered || crmConfigurationIssues(draft).length) return;
    try { sessionStorage.setItem(recoveryKey, JSON.stringify({ at: Date.now(), revision: configuration.revision || JSON.stringify(configuration), value: draft })); }
    catch { setRecoveryNotice('Browser draft recovery is unavailable. Save your changes before leaving.'); }
  }, [draft, dirty, configuration, recovered, recoveryKey]);

  const leave = () => { if (confirmLeave()) router.push('/dashboard/crm/contacts'); };

  const updateDraft = (next: CrmConfiguration) => {
    setDraft(next);
    setIssues([]);
    setSaveError(null);
  };

  const goToStep = (next: number) => {
    if (!draft || saving) return;
    const invalid = next > step ? crmConfigurationIssues(draft).filter(issue => next === 1 ? issue.section === 'stages' : true) : [];
    if (invalid.length) {
      setIssues(invalid.map(issue => issue.message));
      return;
    }
    setIssues([]);
    setStep(next);
    setFurthestStep(Math.max(furthestStep, next));
  };

  const save = async () => {
    if (!draft || saving) return;
    const invalid = crmConfigurationIssues(draft);
    if (invalid.length) {
      setIssues(invalid.map(issue => issue.message));
      setStep(invalid[0].section === 'stages' ? 0 : 1);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const requestedProfile = selectedBusinessProfileId();
    try {
      await api.put<CrmConfiguration>(CRM_CONFIGURATION_API, {
        ...draft, stages: draft.stages.map(stage => ({ ...stage, label: stage.label.trim() })),
      });
      if (selectedBusinessProfileId() !== requestedProfile) return;
      clearRecovery();
      clearGuard();
      toast({ title: 'CRM configuration saved', description: 'Your lead stages and default preferences have been updated.' });
      router.push('/dashboard/crm/contacts');
    } catch (cause) {
      if (selectedBusinessProfileId() === requestedProfile) setSaveError(cause instanceof Error ? cause.message : 'Unable to save CRM configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell maxWidth="xl" padding="md">
      <PageHeader icon={Settings2} title="CRM configuration" subtitle="Configure your lead stages and default pipeline preferences."
        actions={<Button type="button" variant="outline" disabled={saving} onClick={leave}><ArrowLeft className="mr-2 h-4 w-4" /> Back to Contacts</Button>} />
      <WorkspaceSettingsScope detail="Contact stages and default reporting preferences apply to contacts in this workspace." />

      {loading || configuration && !draft ? (
        <LoadingState size="section" className="min-h-64" label="Loading CRM configuration…" showLabel />
      ) : loadError ? (
        <Alert variant="destructive"><AlertTitle>CRM configuration could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{loadError}</span><Button variant="outline" onClick={reload}>Try again</Button></AlertDescription></Alert>
      ) : draft && (
        <>
          {recovered && <Alert><AlertTitle>Unfinished configuration draft</AlertTitle><AlertDescription className="mt-2 space-y-3"><p>A draft for this business profile is available in this tab. Review it before saving.</p><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { updateDraft(recovered); setRecovered(null); }}>Restore unfinished draft</Button><Button variant="outline" size="sm" onClick={clearRecovery}>Discard recovered draft</Button></div></AlertDescription></Alert>}
          {recoveryNotice && <p role="status" className="text-xs text-muted-foreground">{recoveryNotice}</p>}
          <nav aria-label="Configuration steps">
            <ol className="grid grid-cols-3 gap-2 sm:gap-3">
              {steps.map((item, index) => (
                <li key={item.title}>
                  <button type="button" aria-current={step === index ? 'step' : undefined} disabled={saving || index > furthestStep}
                    onClick={() => goToStep(index)} className={cn('flex min-h-20 w-full flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-default sm:min-h-24 sm:flex-row sm:items-center sm:gap-3 sm:p-4',
                      index === step ? 'border-violet-500 bg-card ring-2 ring-violet-500/10' : 'border-border bg-muted/40', index > furthestStep && 'opacity-60')}>
                    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold sm:h-10 sm:w-10',
                      index < step ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : index === step ? 'bg-violet-600 text-white' : 'bg-muted text-muted-foreground')}>
                      {index < step ? <Check className="h-5 w-5" /> : index + 1}
                    </span>
                    <span><span className="block text-xs font-semibold sm:text-sm">{item.title}</span><span className="mt-1 hidden text-xs leading-5 text-muted-foreground sm:block">{item.description}</span></span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          {issues.length > 0 && <Alert variant="destructive"><AlertTitle>Check your configuration</AlertTitle><AlertDescription><ul className="mt-2 list-disc space-y-1 pl-4">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></AlertDescription></Alert>}
          {saveError && <Alert variant="destructive"><AlertTitle>Configuration was not saved</AlertTitle><AlertDescription className="mt-2 space-y-3"><p>{saveError}</p><Button variant="outline" size="sm" onClick={() => { if (window.confirm('Discard your current edits and load the latest saved configuration?')) { clearRecovery(); clearGuard(); reload(); } }}>Load latest saved configuration</Button></AlertDescription></Alert>}

          <Card className="rounded-2xl shadow-none">
            <CardHeader className="p-5 sm:p-7">
              <CardTitle className="text-lg sm:text-xl"><h2>{step === 0 ? 'Configure Lead Stages' : step === 1 ? 'Pipeline Preferences' : 'Review Configuration'}</h2></CardTitle>
              <CardDescription>{step === 0 ? 'Drag to reorder, set types and colors for each stage.' : step === 1 ? 'Choose the defaults for your pipeline analytics.' : 'Review your stages and preferences before saving.'}</CardDescription>
              {step === 0 && <p className="text-sm leading-relaxed text-muted-foreground">Your support agent uses these stage names to update CRM contacts as conversations progress. Set the type to Won or Lost for closed deals. In flow controls visibility in pipeline analytics.</p>}
            </CardHeader>
            <CardContent className="px-5 pb-5 sm:px-7 sm:pb-7">
              <fieldset disabled={saving} className="min-w-0">
                {step === 0 && <CrmStageEditor stages={draft.stages} disabled={saving} onChange={stages => updateDraft({ ...draft, stages })} />}
                {step === 1 && <PreferencesForm preferences={draft.preferences} onChange={preferences => updateDraft({ ...draft, preferences })} />}
                {step === 2 && <ConfigurationReview configuration={draft} previous={configuration || undefined} onEdit={goToStep} />}
              </fieldset>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={leave}>Cancel</Button>{dirty && <Button type="button" variant="outline" disabled={saving} onClick={() => { if (window.confirm('Discard your unsaved configuration changes?')) { updateDraft(structuredClone(configuration!)); clearRecovery(); clearGuard(); } }}>Discard changes</Button>}</div>
            <div className="flex items-center gap-2">
              {step > 0 && <Button type="button" variant="outline" disabled={saving} onClick={() => goToStep(step - 1)}><ArrowLeft className="mr-2 h-4 w-4" /> Back</Button>}
              {step < 2 ? <Button type="button" className="bg-violet-600 text-white hover:bg-violet-700" onClick={() => goToStep(step + 1)}>Next <ArrowRight className="ml-2 h-4 w-4" /></Button> : (
                <Button type="button" loading={saving} loadingText="Saving…" className="bg-violet-600 text-white hover:bg-violet-700" onClick={() => void save()}><Save className="mr-2 h-4 w-4" />Save configuration</Button>
              )}
            </div>
          </div>
          <p role="status" className="text-xs text-muted-foreground">{dirty ? 'Unsaved changes · ' : ''}Configuration is saved for the selected business profile.</p>
        </>
      )}
    </PageShell>
  );
}

function PreferencesForm({ preferences, onChange }: { preferences: CrmPreferences; onChange: (preferences: CrmPreferences) => void }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="sm:col-span-2"><PlatformMultiSelect value={preferences.platform} onChange={platform => onChange({ ...preferences, platform })} /></div>
      <div className="space-y-2">
        <Label htmlFor="crm-date-range">Date Range</Label>
        <select id="crm-date-range" value={preferences.dateRange} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          onChange={event => onChange({ ...preferences, dateRange: event.target.value as CrmPreferences['dateRange'] })}>
          {CRM_DATE_RANGES.map(range => <option key={range.value} value={range.value}>{range.label}</option>)}
        </select>
        <p className="text-xs leading-5 text-muted-foreground">Report on contacts created in this period and stage transitions recorded during it. Pipeline board filters are managed separately.</p>
        {preferences.dateRange === 'custom' && <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="crm-date-start">Start date</Label><Input id="crm-date-start" type="date" value={preferences.dateStart || ''} max={preferences.dateEnd || undefined} onChange={event => onChange({ ...preferences, dateStart: event.target.value })} /></div><div className="space-y-2"><Label htmlFor="crm-date-end">End date</Label><Input id="crm-date-end" type="date" value={preferences.dateEnd || ''} min={preferences.dateStart || undefined} onChange={event => onChange({ ...preferences, dateEnd: event.target.value })} /></div><p className="text-xs text-muted-foreground sm:col-span-2">Both dates are included. Reports use UTC calendar dates.</p></div>}
      </div>
      {[
        { key: 'stuckThreshold', label: 'Stuck Threshold', description: 'Flag open contacts that have stayed in the same stage for this many days.', min: 1, max: 365, suffix: 'days' },
        { key: 'topFlows', label: 'Top Flows', description: 'Maximum number of stage transitions to show in your flow analytics.', min: 1, max: 20, suffix: 'flows' },
        { key: 'minFlowCount', label: 'Min Flow Count', description: 'Only show transitions with at least this many recorded moves.', min: 1, max: 1000, suffix: 'moves' },
      ].map(field => (
        <div key={field.key} className="space-y-2">
          <Label htmlFor={`crm-${field.key}`}>{field.label}</Label>
          <div className="relative">
            <Input id={`crm-${field.key}`} type="number" inputMode="numeric" min={field.min} max={field.max} step={1}
              value={Number.isNaN(preferences[field.key as 'stuckThreshold' | 'topFlows' | 'minFlowCount']) ? '' : preferences[field.key as 'stuckThreshold' | 'topFlows' | 'minFlowCount']}
              className="h-11 rounded-lg pr-16" aria-describedby={`crm-${field.key}-description`}
              onChange={event => onChange({ ...preferences, [field.key]: event.target.value === '' ? NaN : Number(event.target.value) })} />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{field.suffix}</span>
          </div>
          <p id={`crm-${field.key}-description`} className="text-xs leading-5 text-muted-foreground">{field.description}</p>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:col-span-2"><p className="text-xs text-muted-foreground">Restore reporting preferences while keeping your configured stages.</p><Button type="button" variant="outline" size="sm" onClick={() => onChange(structuredClone(DEFAULT_CRM_CONFIGURATION.preferences))}>Reset reporting preferences</Button></div>
    </div>
  );
}

function ConfigurationReview({ configuration, previous, onEdit }: { configuration: CrmConfiguration; previous?: CrmConfiguration; onEdit: (step: number) => void }) {
  const preferences = configuration.preferences;
  const changes = previous ? [
    ...previous.stages.filter(stage => !configuration.stages.some(next => next.key === stage.key)).map(stage => `Remove “${stage.label}”. Contacts and rules using this stage must be updated first; saving checks those references.`),
    ...configuration.stages.flatMap(stage => {
      const before = previous.stages.find(item => item.key === stage.key);
      if (!before) return [`Add “${stage.label}”.`];
      return [before.label !== stage.label ? `Rename “${before.label}” to “${stage.label}”; contact history keeps the same stage identity.` : '',
        before.type !== stage.type ? `Change “${stage.label}” from ${before.type} to ${stage.type}. Reporting for existing contacts in this stage will use the new type.` : '',
        before.inFlow !== stage.inFlow ? `${stage.inFlow ? 'Include' : 'Exclude'} “${stage.label}” in flow reports; contacts remain accessible.` : ''].filter(Boolean);
    }),
  ] : [];
  const values = [
    ['Date Range', crmDateRangeLabel(preferences)],
    ['Platforms', crmPlatformLabel(preferences)],
    ['Stuck Threshold', `${preferences.stuckThreshold} days`],
    ['Top Flows', String(preferences.topFlows)],
    ['Min Flow Count', String(preferences.minFlowCount)],
  ];
  return (
    <div className="space-y-7">
      {changes.length > 0 && <section className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h2 className="text-sm font-semibold">What changes when you save</h2><ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-5 text-muted-foreground">{changes.map((change,index)=><li key={index}>{change}</li>)}</ul></section>}
      <section>
        <div className="mb-3 flex items-center justify-between border-b border-border pb-3">
          <h2 className="text-sm font-semibold">Stages ({configuration.stages.length})</h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(0)}>Edit stages</Button>
        </div>
        <ol className="space-y-2">
          {configuration.stages.map(stage => (
            <li key={stage.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/55 px-4 py-3">
              <span className="flex min-w-0 items-center gap-3 text-sm font-medium"><span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: stage.color }} /> <span className="min-w-0 [overflow-wrap:anywhere]">{stage.label}</span></span>
              <span className="flex items-center gap-2">{!stage.inFlow && <span className="text-xs text-muted-foreground">Excluded from flow</span>}<Badge variant="secondary" className={cn('rounded-md text-[10px] uppercase tracking-wider', stage.type === 'won' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', stage.type === 'lost' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400', stage.type === 'active' && 'bg-violet-500/10 text-violet-600 dark:text-violet-400')}>{stage.type}</Badge></span>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <div className="mb-3 flex items-center justify-between border-b border-border pb-3">
          <h2 className="text-sm font-semibold">Preferences</h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(1)}>Edit preferences</Button>
        </div>
        <dl className="space-y-2">
          {values.map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 rounded-lg bg-muted/55 px-4 py-3 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-semibold">{value}</dd></div>)}
        </dl>
      </section>
    </div>
  );
}
