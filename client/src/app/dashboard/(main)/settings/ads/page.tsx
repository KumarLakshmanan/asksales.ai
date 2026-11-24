"use client";

import Link from 'next/link';
import styles from '@/components/marketing/marketing.module.css';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Info, MinusCircle, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { PageErrorState } from '@/components/ui/page-state';
import { SettingsSectionSkeleton } from '@/components/skeletons';
import { SettingsPanel, SettingsSaveBar, SettingsTabs } from '@/components/settings/SettingsSurface';
import { WorkspaceSettingsScope } from '@/components/settings/WorkspaceSettingsScope';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import api from '@/lib/api';
import { Callout } from '@/components/ui/callout';

interface AdLocation { countryCode: string; region?: string; city?: string; googleGeoTargetId?: string; metaLocationKey?: string }
interface AdSettings {
  defaultLifetimeBudget: number;
  currency: 'USD' | 'EUR' | 'GBP' | 'INR' | 'CAD' | 'AUD' | 'JPY' | 'BRL' | 'MXN' | 'SGD' | 'AED';
  locations: AdLocation[]; autonomousOptimizationEnabled: boolean; liveProviderMutationsEnabled: boolean; analyticsSyncMinutes: number;
}
interface Readiness { meta: boolean; google: boolean; reasons: { meta?: string; google?: string } }
interface AdAutonomySettings { mode: 'off' | 'shadow' | 'advisory' | 'live_pause'; enabled: boolean; policyVersion: string; consentedAt: string | null; notificationEmail: string | null; defaultThresholds: Record<string, number> }
const CURRENCIES: AdSettings['currency'][] = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'BRL', 'MXN', 'SGD', 'AED'];
const MODES = [ { value: 'off', label: 'Off', description: 'AI does not evaluate campaign performance.' }, { value: 'shadow', label: 'Evaluate privately', description: 'Evaluate performance without recommendations or campaign changes.' }, { value: 'advisory', label: 'Recommendations only', description: 'Review suggestions and decide which actions to take.' }, { value: 'live_pause', label: 'Pause with campaign consent', description: 'AI can pause underperforming ads only when each campaign also has consent.' } ] as const;

export default function AdSettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AdSettings | null>(null), [autonomy, setAutonomy] = useState<AdAutonomySettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<AdSettings | null>(null), [savedAutonomy, setSavedAutonomy] = useState<AdAutonomySettings | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null), [environmentGate, setEnvironmentGate] = useState(false);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [saveError, setSaveError] = useState('');
  const [tab, setTab] = useState('defaults');
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings), autonomyDirty = JSON.stringify(autonomy) !== JSON.stringify(savedAutonomy), dirty = settingsDirty || autonomyDirty;
  useUnsavedChanges(dirty);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [response, autonomyResponse] = await Promise.all([api.get<{ settings: AdSettings; readiness: Readiness; environmentMutationGate: boolean }>('/api/settings/ads'), api.get<{ settings: AdAutonomySettings }>('/api/settings/ads/autonomy')]);
      setSettings(response.settings); setSavedSettings(response.settings); setAutonomy(autonomyResponse.settings); setSavedAutonomy(autonomyResponse.settings); setReadiness(response.readiness); setEnvironmentGate(response.environmentMutationGate);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load Ad Settings.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!settings || !autonomy || saving || !dirty) return;
    setSaving(true); setSaveError('');
    try {
      if (settingsDirty || autonomy.mode !== savedAutonomy?.mode) {
        const response = await api.put<{ settings: AdSettings }>('/api/settings/ads', { ...settings, autonomousOptimizationEnabled: autonomy.mode !== 'off' });
        setSettings(response.settings); setSavedSettings(response.settings);
      }
      if (autonomyDirty) {
        const response = await api.put<{ settings: AdAutonomySettings }>('/api/settings/ads/autonomy', { mode: autonomy.mode, notificationEmail: autonomy.notificationEmail || null, defaultThresholds: autonomy.defaultThresholds || {} });
        setAutonomy(response.settings); setSavedAutonomy(response.settings);
      }
      toast({ title: 'Ad Settings saved', description: 'New campaigns will use these budget and targeting defaults.' });
    } catch (failure) {
      setSaveError('Some changes could not be saved. Successfully saved sections are kept; your remaining edits are ready to retry.');
      toast({ title: 'Unable to save all Ad Settings', description: failure instanceof Error ? failure.message : 'Please try again.', variant: 'destructive' });
    } finally { setSaving(false); }
  };
  if (loading) return <SettingsSectionSkeleton />;
  if (error || !settings || !autonomy) return <PageErrorState title="Ad Settings could not be loaded" description={error || 'Saved settings are unavailable.'} reset={() => void load()} />;
  const updateLocation = (index: number, patch: Partial<AdLocation>) => setSettings({ ...settings, locations: settings.locations.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const operatingMode = <div className="space-y-3"><Label htmlFor="ad-ai-mode">AI operating mode</Label><Select value={autonomy.mode} onValueChange={(mode: AdAutonomySettings['mode']) => setAutonomy({ ...autonomy, mode })}><SelectTrigger id="ad-ai-mode" aria-label="AI operating mode"><SelectValue /></SelectTrigger><SelectContent>{MODES.map(mode => <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>)}</SelectContent></Select><p className="text-sm leading-6 text-muted-foreground">{MODES.find(mode => mode.value === autonomy.mode)?.description}</p></div>;
  const checklist = <SettingsPanel title="Activation checklist" className="lg:sticky lg:top-6">
    <div className="divide-y">{[{ name: 'Meta account', ready: readiness?.meta, reason: readiness?.reasons.meta }, { name: 'Google Ads account', ready: readiness?.google, reason: readiness?.reasons.google }].map(item => <div key={item.name} className="flex gap-3 py-4 first:pt-0">{item.ready ? <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-success" /> : <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-warning" />}<div className="min-w-0"><h3 className="text-sm font-semibold">{item.name}: {item.ready ? 'ready' : 'action needed'}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{item.ready ? 'Connection is ready for campaign setup.' : 'Connect the account in Integrations, then choose which advertising account campaigns should use.'}</p><Link href="/dashboard/integrations" className="mt-2 inline-block text-sm text-primary hover:underline">Manage connection</Link>{!item.ready && item.reason && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Connection details</summary><p className="mt-2 break-words">{item.reason}</p></details>}</div></div>)}
      <div className="flex gap-3 py-4">{settings.locations.length && settings.locations.every(item => /^[A-Z]{2}$/.test(item.countryCode)) ? <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0 text-success" /> : <AlertCircle aria-hidden className="h-5 w-5 shrink-0 text-warning" />}<div><h3 className="text-sm font-semibold">{settings.locations.length ? 'Default locations configured' : 'Default location missing'}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Set at least one valid location before activating a campaign.</p><Button variant="link" className="mt-1 h-auto p-0" onClick={() => setTab('defaults')}>Review locations</Button></div></div>
      <div className="flex gap-3 py-4">{environmentGate ? <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0 text-success" /> : <MinusCircle aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />}<div><h3 className="text-sm font-semibold">Live campaign actions {environmentGate ? 'available on this server' : 'disabled on this server'}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{environmentGate ? 'Workspace permission and campaign consent still apply.' : 'You can prepare campaigns while activation is unavailable. Ask an administrator to enable live actions.'}</p></div></div>
    </div><p className="mt-3 flex gap-2 rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground"><Info aria-hidden className="h-4 w-4 shrink-0" />AI never increases budgets automatically.</p>
  </SettingsPanel>;
  const valid = settings.defaultLifetimeBudget > 0 && Number.isFinite(settings.defaultLifetimeBudget) && settings.analyticsSyncMinutes >= 5 && settings.analyticsSyncMinutes <= 1440 && settings.locations.every(item => /^[A-Z]{2}$/.test(item.countryCode));
  return <div className={`${styles.surface} ${styles.settingsSurface} mx-auto w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8`}>
    <header className={styles.header}><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Ad Settings</h1><p className="mt-2 text-sm text-muted-foreground">Set campaign defaults and decide what AI can change.</p></header>
    <WorkspaceSettingsScope detail="Campaign defaults and AI permissions for this workspace." className="max-sm:flex-col max-sm:gap-1" />
    {saveError && <Callout tone="danger">{saveError}</Callout>}
    <Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-5">
      <SettingsTabs label="Ad settings sections" items={[{ value: 'defaults', label: 'Campaign defaults' }, { value: 'permissions', label: 'AI permissions' }, { value: 'readiness', label: 'Connection readiness' }]} />
      {tab === 'permissions' && !environmentGate && <Callout tone="warning" announce icon={AlertCircle} title="Server live actions disabled">You can save these settings. Live actions remain unavailable until the server is enabled; workspace permission, account mode and campaign consent still apply.</Callout>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)]">
        <fieldset disabled={saving} className="min-w-0">
          <TabsContent value="defaults" className="mt-0 space-y-5">
            <SettingsPanel title="Campaign budget limit" description="Maximum lifetime budget for a new campaign."><div className="grid gap-4 sm:grid-cols-[1fr_180px]"><div className="space-y-2"><Label htmlFor="default-budget">Amount</Label><Input id="default-budget" type="number" min={1} step="0.01" value={settings.defaultLifetimeBudget} onChange={event => setSettings({ ...settings, defaultLifetimeBudget: Number(event.target.value) })} /></div><div className="space-y-2"><Label htmlFor="ad-currency">Currency</Label><Select value={settings.currency} onValueChange={(currency: AdSettings['currency']) => setSettings({ ...settings, currency })}><SelectTrigger id="ad-currency"><SelectValue /></SelectTrigger><SelectContent>{CURRENCIES.map(currency => <SelectItem key={currency} value={currency}>{currency}</SelectItem>)}</SelectContent></Select></div></div><p className="mt-3 text-xs leading-5 text-muted-foreground">The combined spend of all ad sets and ad groups stays within this cap. You can set a different cap when reviewing a campaign. Existing campaigns are unchanged.</p></SettingsPanel>
            <SettingsPanel title="Default locations" description="Applied to new campaigns unless their targeting overrides these defaults." action={<Button variant="outline" size="sm" onClick={() => setSettings({ ...settings, locations: [...settings.locations, { countryCode: '' }] })}><Plus aria-hidden className="mr-2 h-4 w-4" />Add location</Button>}>
              {!settings.locations.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Add a location before activating a campaign.</p>}
              <div className="space-y-3">{settings.locations.map((location, index) => <div key={index} className="rounded-lg border p-4"><div className="flex items-end gap-3"><div className="flex-1 space-y-2"><Label htmlFor={`ad-country-${index}`}>Country code</Label><Input id={`ad-country-${index}`} maxLength={2} placeholder="US" value={location.countryCode} onChange={event => updateLocation(index, { countryCode: event.target.value.toUpperCase() })} /></div><Button variant="ghost" size="icon" aria-label={`Remove location ${index + 1}`} onClick={() => setSettings({ ...settings, locations: settings.locations.filter((_, i) => i !== index) })}><Trash2 aria-hidden className="h-4 w-4" /></Button></div><details className="mt-3 text-sm"><summary className="cursor-pointer text-muted-foreground">Advanced location identifiers</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="space-y-2 text-xs">Google location resource<Input placeholder="geoTargetConstants/2840" value={location.googleGeoTargetId || ''} onChange={event => updateLocation(index, { googleGeoTargetId: event.target.value || undefined })} /></label><label className="space-y-2 text-xs">Meta location key<Input placeholder="Optional region or city key" value={location.metaLocationKey || ''} onChange={event => updateLocation(index, { metaLocationKey: event.target.value || undefined })} /></label></div></details></div>)}</div>
            </SettingsPanel>
            <SettingsPanel title="AI operating mode">{operatingMode}<Button variant="link" className="mt-3 h-auto p-0" onClick={() => setTab('permissions')}>Manage AI permissions <ArrowRight aria-hidden className="ml-2 h-4 w-4" /></Button></SettingsPanel>
            <details className="rounded-xl border bg-card p-5"><summary className="cursor-pointer text-sm font-semibold">Advanced details</summary><div className="mt-4 space-y-2"><Label htmlFor="analytics-sync">Analytics refresh interval (minutes)</Label><Input id="analytics-sync" type="number" min={5} max={1440} value={settings.analyticsSyncMinutes} onChange={event => setSettings({ ...settings, analyticsSyncMinutes: Number(event.target.value) })} /><p className="text-xs text-muted-foreground">Refresh Meta and Google performance data every 5–1,440 minutes.</p></div></details>
          </TabsContent>
          <TabsContent value="permissions" className="mt-0 space-y-5"><SettingsPanel title="AI permissions" description="Control how AI evaluates performance and whether it can pause campaigns.">{operatingMode}<div className="mt-6 space-y-2"><Label htmlFor="pause-email">Pause notification email</Label><Input id="pause-email" type="email" placeholder="owner@company.com" value={autonomy.notificationEmail || ''} onChange={event => setAutonomy({ ...autonomy, notificationEmail: event.target.value || null })} /><p className="text-xs leading-5 text-muted-foreground">Successful AI pauses create an in-app notification and an email.</p></div><div className="mt-4 border-t pt-4"><h3 className="mb-3 text-xs font-semibold">Permission to change live campaigns</h3><div className="flex items-start justify-between gap-4"><div><Label htmlFor="ad-live-actions">Allow publishing and manual campaign actions</Label><p className="mt-2 text-sm leading-6 text-muted-foreground">AI pauses also require the operating mode above, server availability, and consent on each campaign.</p></div><Switch id="ad-live-actions" checked={settings.liveProviderMutationsEnabled} onCheckedChange={liveProviderMutationsEnabled => setSettings({ ...settings, liveProviderMutationsEnabled })} /></div><div className="mt-4 space-y-2 border-t pt-3 text-sm leading-6 text-muted-foreground"><p><strong className="text-foreground">Allowed with consent:</strong> pause an ad, ad set, ad group, or campaign.</p><p><strong className="text-foreground">Always manual:</strong> resume campaigns, increase budgets, change targeting, or replace ads.</p><p>Switching the operating mode off cancels pending AI pauses.</p><div className="flex flex-wrap gap-2"><Badge variant="outline">Policy {autonomy.policyVersion}</Badge><span className="text-xs">Consent: {autonomy.consentedAt ? new Date(autonomy.consentedAt).toLocaleString() : 'Not granted'}</span></div></div></div><div className="mt-4 border-t pt-4"><h3 className="mb-2 text-xs font-semibold">AI capability matrix</h3>
              <div className="overflow-x-auto"><table className={styles.comparison}><thead><tr><th scope="col">Capability</th><th scope="col">Availability</th></tr></thead><tbody>
                <tr><td>Performance evaluation</td><td>{autonomy.mode === 'off' ? 'Off' : autonomy.mode === 'shadow' ? 'Private evaluation' : 'Recommendations enabled'}</td></tr>
                <tr><td>AI pause</td><td>Requires server availability, account pause mode and campaign consent</td></tr>
                {['Resume campaigns', 'Increase budgets', 'Change targeting', 'Replace ads'].map(capability => <tr key={capability}><td>{capability}</td><td>Always manual</td></tr>)}
              </tbody></table></div>
            </div></SettingsPanel>
          </TabsContent>
          <TabsContent value="readiness" className="mt-0"><SettingsPanel title="Connection readiness" description="Review the current blockers and the next step for each requirement."><div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left text-xs"><thead><tr><th className="pb-3">Requirement</th><th className="pb-3">Current status</th><th className="pb-3">Next step</th></tr></thead><tbody className="divide-y"><tr><td className="py-3">Meta ad account</td><td>{readiness?.meta ? 'Ready' : 'Needs setup'}</td><td><Link className="text-primary hover:underline" href="/dashboard/integrations/meta">Manage connection</Link></td></tr><tr><td className="py-3">Google Ads account</td><td>{readiness?.google ? 'Ready' : 'Needs setup'}</td><td><Link className="text-primary hover:underline" href="/dashboard/integrations">Manage connection</Link></td></tr><tr><td className="py-3">Default targeting</td><td>{settings.locations.length && settings.locations.every(item => /^[A-Z]{2}$/.test(item.countryCode)) ? 'Configured' : 'Location required'}</td><td><Button variant="link" size="sm" className="h-auto p-0" onClick={() => setTab('defaults')}>Review locations</Button></td></tr><tr><td className="py-3">Live provider actions</td><td>{!environmentGate ? 'Server disabled' : settings.liveProviderMutationsEnabled ? 'Workspace allowed' : 'Workspace permission off'}</td><td><Button variant="link" size="sm" className="h-auto p-0" onClick={() => setTab('permissions')}>Review permissions</Button></td></tr><tr><td className="py-3">Campaign pause consent</td><td>Required on each campaign</td><td><Link href="/dashboard/ads?tab=automation" className="text-primary hover:underline">Review campaigns</Link></td></tr></tbody></table></div></SettingsPanel><SettingsPanel title="Before you activate a campaign" description="Review connection readiness alongside these workspace defaults."><ul className="list-disc space-y-3 pl-4 text-sm leading-6 text-muted-foreground"><li>Connect an advertising account in Integrations.</li><li>Set a campaign budget and at least one valid target location.</li><li>Enable live campaign actions in AI permissions when you are ready to publish.</li><li>For AI pauses, grant consent on each campaign and choose a pause notification email.</li></ul><Button asChild variant="outline" className="mt-5"><Link href="/dashboard/integrations">Manage integrations</Link></Button></SettingsPanel></TabsContent>
        </fieldset>{checklist}
      </div>
    </Tabs>
    {!valid && <p role="alert" className="text-sm text-destructive">Enter a positive budget, a refresh interval from 5 to 1,440 minutes, and a two-letter code for each location.</p>}
    <SettingsSaveBar dirty={dirty} saving={saving} disabled={!valid} onDiscard={() => { setSettings(savedSettings); setAutonomy(savedAutonomy); setSaveError(''); }} onSave={() => void save()}>Changes apply to defaults for new campaigns.{dirty ? ' Unsaved changes.' : ''}</SettingsSaveBar>
  </div>;
}
