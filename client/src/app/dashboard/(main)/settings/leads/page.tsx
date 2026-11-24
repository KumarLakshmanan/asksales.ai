"use client";

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { ArrowDown, ArrowRight, Briefcase, Map, Instagram, Facebook, Twitter, MapPin, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { api } from '@/lib/api';
import { PageErrorState, PageLoadingState } from '@/components/ui/page-state';
import { SettingsPanel, SettingsSaveBar } from '@/components/settings/SettingsSurface';

const SOURCES = [
  { id: 'linkedin', name: 'LinkedIn', icon: Briefcase, color: 'text-[#0077B5]' },
  { id: 'google', name: 'Google Maps', icon: Map, color: 'text-[#4285F4]' },
  { id: 'justdial', name: 'JustDial', icon: MapPin, color: 'text-[#c44e00] dark:text-orange-400' },
  { id: 'instagram', name: 'Instagram', icon: Instagram, color: 'text-[#bc1888] dark:text-pink-400' },
  { id: 'facebook', name: 'Facebook', icon: Facebook, color: 'text-[#0668E1]' },
  { id: 'twitter', name: 'Twitter / X', icon: Twitter, color: 'text-foreground' },
];

export default function LeadSettings() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [loadError, setLoadError] = useState(false);
  const [sources, setSources] = useState<string[]>([]), [savedSources, setSavedSources] = useState<string[]>([]);
  const hasChanges = sources.length !== savedSources.length || sources.some(source => !savedSources.includes(source));
  useUnsavedChanges(hasChanges);
  const fetchLeadSettings = useCallback(async () => {
    try {
      setLoading(true); setLoadError(false);
      const response = await api.get<{ leadSources?: string[] }>('/api/settings/leads');
      if (!Array.isArray(response?.leadSources) || !response.leadSources.length || response.leadSources.some(source => ![...SOURCES.map(item => item.id), 'yelp'].includes(source))) throw new Error('Invalid saved lead sources');
      const supported = [...new Set(response.leadSources.filter(source => source !== 'yelp'))];
      if (!supported.length) throw new Error('No supported fallback sources saved');
      setSources(supported); setSavedSources(supported);
    } catch { setLoadError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void fetchLeadSettings(); }, [fetchLeadSettings]);
  const toggleSource = (id: string) => {
    if (sources.includes(id) && sources.length === 1) {
      toast({ title: 'Choose a fallback source', description: 'At least one supported lead source must remain selected.', variant: 'destructive' }); return;
    }
    setSources(sources.includes(id) ? sources.filter(source => source !== id) : [...sources, id]);
  };
  const save = async () => {
    if (saving || !hasChanges) return;
    setSaving(true);
    try {
      await api.put('/api/settings/leads', { leadSources: sources });
      setSavedSources([...sources]);
      toast({ title: 'Settings Saved', description: 'Your fallback discovery sources have been updated.' });
    } catch (error) { toast({ title: 'Save Error', description: error instanceof Error ? error.message : 'Failed to update settings', variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  if (loading) return <PageLoadingState label="Loading lead settings…" />;
  if (loadError) return <PageErrorState title="Lead settings unavailable" description="Your saved lead rules could not be loaded, so no defaults have been applied." reset={fetchLeadSettings} />;
  return <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <header><h1 className="text-2xl font-semibold tracking-tight">Lead discovery defaults</h1><p className="mt-2 text-sm text-muted-foreground">Choose fallback sources for workflows without an explicit discovery source.</p></header>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,1fr)]">
      <SettingsPanel title="Fallback sources">
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Supported sources</h3>
        <div className="divide-y border-y">{SOURCES.map(({ id, name, icon: Icon, color }) => <label key={id} className="flex min-h-16 cursor-pointer items-center gap-4 py-3">
          <Checkbox checked={sources.includes(id)} disabled={saving} onCheckedChange={() => toggleSource(id)} aria-label={`Select ${name} as a fallback source`} />
          <Icon aria-hidden className={`h-6 w-6 shrink-0 ${color}`} /><span className="flex-1 text-sm font-medium">{name}</span>{sources.includes(id) && <span className="text-xs text-primary">Selected</span>}
        </label>)}</div>
        <h3 className="mb-2 mt-7 text-sm font-medium text-muted-foreground">Unavailable sources</h3>
        <div className="flex items-start gap-4 border-t pt-4"><Checkbox disabled checked={false} aria-label="Yelp is not supported" /><Star aria-hidden className="h-6 w-6 shrink-0 text-muted-foreground" /><div><div className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">Yelp</span><Badge variant="secondary">Not supported</Badge></div><p className="mt-1 text-xs leading-5 text-muted-foreground">This source cannot currently be saved as a fallback.</p></div></div>
      </SettingsPanel>
      <SettingsPanel title="How these defaults are used">
        <ol className="space-y-3"><li className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">1</span><div><h3 className="text-sm font-semibold">Workflow specifies a source</h3><p className="mt-1 text-sm text-muted-foreground">Use that source.</p></div></li><li aria-hidden className="pl-2"><ArrowDown className="h-4 w-4 text-muted-foreground" /></li><li className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">2</span><div><h3 className="text-sm font-semibold">No source specified</h3><p className="mt-1 text-sm text-muted-foreground">Use the selected fallback sources.</p></div></li></ol>
        <div className="mt-7 border-t pt-6"><p className="text-sm font-medium">Messaging accounts are managed in Integrations.</p><Link href="/dashboard/integrations" className="mt-2 inline-flex items-center gap-2 text-sm text-primary hover:underline">Manage integrations <ArrowRight aria-hidden className="h-4 w-4" /></Link></div>
        <p className="mt-7 border-t pt-6 text-sm leading-6 text-muted-foreground">Enrichment, scoring, qualification, and deduplication are configured in each workflow.</p>
      </SettingsPanel>
    </div>
    <SettingsSaveBar dirty={hasChanges} saving={saving} onDiscard={() => setSources([...savedSources])} onSave={() => void save()} label="Save defaults">{sources.length} fallback {sources.length === 1 ? 'source' : 'sources'} selected{hasChanges ? ' · Unsaved changes' : ''}</SettingsSaveBar>
  </div>;
}
