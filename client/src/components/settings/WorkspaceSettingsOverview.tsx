"use client";

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Search, Building2, Users, Plug, Database, FileText, Send, Target, Megaphone, Bot, MessageSquare, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { SettingsTabs } from '@/components/settings/SettingsSurface';
import { useBusinessProfiles, businessProfileName } from '@/hooks/use-business-profiles';
import { usePlatformAccess } from '@/hooks/use-platform-access';
import { useAuth } from '@/contexts/AuthContext';
import { SETTINGS_GROUP_LABELS, workspaceSettingsDestinations } from '@/lib/settings-navigation';

export function WorkspaceSettingsOverview({ destinationIds }: { destinationIds?: readonly string[] }) {
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const { user, isLoading: authLoading } = useAuth();
  const profiles = useBusinessProfiles();
  const access = usePlatformAccess(Boolean(user) && !authLoading);
  if (profiles.isError || access.isError) return <div role="alert" className="space-y-3 rounded-xl border p-5"><p>Workspace configuration could not be verified. Try again to load your available settings.</p><Button type="button" variant="outline" onClick={() => { void profiles.refetch(); void access.refetch(); }}>Try again</Button></div>;
  if (authLoading || !user || profiles.isLoading || access.isLoading || !access.data) return <p role="status" className="rounded-xl border p-5 text-sm text-muted-foreground">Checking workspace configuration access…</p>;
  const profile = profiles.activeProfile;
  if (!profile) return <div className="space-y-3 rounded-xl border border-dashed p-5"><p>Choose a workspace to see its configuration.</p><Button asChild variant="outline"><Link href="/dashboard/select-profile">Choose a workspace</Link></Button></div>;
  const destinations = workspaceSettingsDestinations(profile, access.data).filter(item => !destinationIds || destinationIds.includes(item.id));
  const visible = destinations.filter(item => (groupFilter === 'all' || item.group === groupFilter) && `${item.label} ${item.description} ${item.scope} ${SETTINGS_GROUP_LABELS[item.group]}`.toLowerCase().includes(search.trim().toLowerCase()));
  const icons: Record<string, typeof Search> = { profile: Building2, staff: Users, integrations: Plug, crm: Database, proposals: FileText, 'follow-ups': Send, leads: Target, ads: Megaphone, assistants: Bot, widget: MessageSquare, 'support-teams': Users, 'support-notifications': Bell };
  const categories = [{ value: 'all', label: 'All settings' }, ...Object.entries(SETTINGS_GROUP_LABELS).filter(([key]) => destinations.some(item => item.group === key)).map(([value, label]) => ({ value, label }))];
  const results = !destinations.length ? <p role="status" className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">No configuration links are available for your role and enabled modules in this workspace.</p> : !visible.length ? <div role="status" className="rounded-xl border border-dashed p-8 text-center"><p className="text-sm font-medium">No settings match your search.</p><Button variant="link" onClick={() => { setSearch(''); setGroupFilter('all'); }}>Clear filters</Button></div> : <div className="overflow-hidden rounded-xl border bg-card">{Object.entries(SETTINGS_GROUP_LABELS).map(([group, label]) => {
      const items = visible.filter(item => item.group === group);
      if (!items.length) return null;
      return <section key={group} aria-label={label} className="border-b last:border-b-0"><h2 className="px-5 pb-3 pt-5 text-base font-semibold">{label}</h2><div className="divide-y px-5">{items.map(item => { const Icon = icons[item.id] || Search; return <Link key={item.id} href={item.href} prefetch={false} className="group grid min-w-0 grid-cols-[24px_minmax(0,1fr)_16px] items-center gap-x-3 gap-y-1 py-4 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-[24px_180px_minmax(0,1fr)_auto_16px]">
        <Icon aria-hidden className="row-span-3 mt-0.5 h-5 w-5 self-start text-muted-foreground lg:row-span-1 lg:mt-0 lg:self-center" /><span className="text-sm font-medium group-hover:text-primary">{item.label}</span><span className="col-start-2 text-sm leading-6 text-muted-foreground lg:col-auto">{item.description}</span>
        <Badge variant="secondary" className="col-start-2 w-fit whitespace-normal text-xs font-normal lg:col-auto">{item.scope}{item.readOnly ? ' · View only' : ''}</Badge><ArrowRight aria-hidden className="col-start-3 row-start-1 h-4 w-4 text-muted-foreground lg:col-auto lg:row-auto" />
      </Link>; })}</div></section>;
    })}<p className="px-5 py-4 text-xs text-muted-foreground">Only settings available to your role and enabled modules are shown.</p></div>;
  return <section aria-label="Workspace configuration links" className="space-y-5">
    <div className="rounded-xl border bg-card p-4 text-sm">
      <p className="break-words font-medium">Workspace: {businessProfileName(profile)}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Settings apply to the selected workspace. Account, channel and support team settings are identified below.</p>
    </div>
    {!!destinations.length && <><SearchInput aria-label="Search workspace settings" placeholder="Search settings, channels, or features" className="h-11" value={search} onValueChange={setSearch} />
      </>}
    <Tabs value={groupFilter} onValueChange={setGroupFilter} className="min-w-0 space-y-5">
      {!!destinations.length && <SettingsTabs label="Settings categories" items={categories} />}
    {categories.map(category => <TabsContent key={category.value} value={category.value} className="mt-0">{category.value === groupFilter ? results : null}</TabsContent>)}
    </Tabs>
  </section>;
}
