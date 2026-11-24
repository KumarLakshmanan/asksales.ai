"use client";

import { Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Clock3, Facebook, History, Inbox, Info, Instagram, LayoutTemplate, Mail, MessageCircle, MessageSquare, Settings2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import { FollowUpSettings } from '@/components/FollowUpSettings';
import { FollowUpHistory } from '@/components/follow-ups/FollowUpHistory';
import { FollowUpTemplates } from '@/components/follow-ups/FollowUpTemplates';
import { getFollowUpSaveRecovery, getServerFollowUpSaveRecovery, subscribeFollowUpSaveRecovery, startFollowUpSave } from '@/lib/follow-up-save-recovery';
import { FOLLOW_UP_CHANNELS, type FollowUpChannel } from '../../../../../../../shared/followUpChannels';

const labels = { email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', sms: 'SMS' };
const channelIcons = { email: Mail, whatsapp: MessageCircle, instagram: Instagram, facebook: Facebook, sms: MessageSquare };

function FollowUpsContent() {
  const scope = useOutreachDraftScope();
  return <FollowUpsWorkspace key={scope} />;
}

function FollowUpsWorkspace() {
  const scope = useOutreachDraftScope();
  const saves = useSyncExternalStore(subscribeFollowUpSaveRecovery, useCallback(() => getFollowUpSaveRecovery(scope), [scope]), getServerFollowUpSaveRecovery);
  const params = useSearchParams();
  const router = useRouter();
  const requestedChannel = params?.get('channel') as FollowUpChannel;
  const validChannel = FOLLOW_UP_CHANNELS.includes(requestedChannel) ? requestedChannel : 'email';
  const [channel, setChannel] = useState<FollowUpChannel>(validChannel);
  const requestedTab = ['history', 'templates'].includes(params?.get('tab') || '') ? params?.get('tab') || 'settings' : 'settings';
  const [tab, setTab] = useState(requestedTab);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const holdChannelTabs = tab === 'settings' && settingsLoading;
  // Finder navigation can change the query while this page remains mounted.
  useEffect(() => { setTab(requestedTab); }, [requestedTab]);
  useEffect(() => { setChannel(validChannel); }, [validChannel]);
  const selectChannel = (value: string) => {
    setChannel(value as FollowUpChannel);
    const next = new URLSearchParams(params?.toString() || '');
    next.set('channel', value);
    next.set('tab', tab);
    router.replace(`/dashboard/outreach/follow-ups?${next}`, { scroll: false });
  };
  const selectTab = (value: string) => {
    setTab(value);
    const next = new URLSearchParams(params?.toString() || '');
    next.set('tab', value);
    next.set('channel', channel);
    router.replace(`/dashboard/outreach/follow-ups?${next}`, { scroll: false });
  };
  return <div className="outreach-workspace follow-up-workspace mx-auto w-full max-w-[1460px] space-y-4 p-4 sm:p-6 lg:p-8">
    <PageHeader className="workspace-heading" icon={Clock3} title="Follow-ups" subtitle="Manage channel defaults for reviewed outbound outreach, templates and delivery history." actions={<><Button variant="outline" size="sm" asChild><Link href="/dashboard/outreach/inbox"><Inbox className="mr-2 h-4 w-4" />Inbox</Link></Button><Button variant="outline" size="sm" asChild><Link href="/dashboard/outreach/activity">Activity</Link></Button></>} />
    <Tabs value={channel} onValueChange={selectChannel}><TabsList aria-label="Follow-up channel" className="workspace-channel-tabs h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">{FOLLOW_UP_CHANNELS.map(value => { const Icon = channelIcons[value]; return <TabsTrigger className="min-h-11 flex-1 gap-2 border bg-card" key={value} value={value} disabled={holdChannelTabs && value !== channel}><Icon className="h-4 w-4" />{labels[value]}</TabsTrigger>; })}</TabsList></Tabs>
    <Tabs value={tab} onValueChange={selectTab} className="space-y-4"><TabsList aria-label="Follow-up workspace" className="workspace-section-tabs h-auto w-full justify-start rounded-none border-b bg-transparent p-0"><TabsTrigger className="min-h-11" value="settings"><Settings2 className="mr-2 h-4 w-4" />Settings</TabsTrigger><TabsTrigger className="min-h-11" value="history"><History className="mr-2 h-4 w-4" />History</TabsTrigger><TabsTrigger className="min-h-11" value="templates"><LayoutTemplate className="mr-2 h-4 w-4" />Templates</TabsTrigger></TabsList>
      <div className="workspace-scope-notice flex-wrap justify-between"><p className="flex items-center gap-2 font-medium"><Info className="h-4 w-4 text-primary" />Channel defaults · {labels[channel]}</p><p className="max-w-2xl text-xs leading-5 text-muted-foreground">Published assistants configure support follow-ups separately; their sequence takes precedence for their own published support reply. A customer reply cancels pending follow-ups.</p></div>
      <TabsContent value="settings">
        {saves[channel]?.unconfirmed && <p role="status" className="mb-4 text-sm text-muted-foreground">A previous settings save is unconfirmed. Retry the same save; outreach review stays blocked until its saved revision is verified.</p>}
        <FollowUpSettings key={channel} integrationKey={channel} saveDisabled={Boolean(saves[channel]?.pending)}
          initialAttempt={saves[channel]?.pending ? saves[channel]?.attempted : saves[channel]?.unconfirmed}
          onSaveStart={settings => startFollowUpSave(scope, channel, settings, null)}
          onLoadingChange={setSettingsLoading} />
        <div className="mt-3 grid gap-3 lg:grid-cols-2"><section className="workspace-panel rounded-lg border bg-card p-4"><h2 className="text-sm font-semibold">Scope</h2><dl className="mt-3 space-y-3 text-xs leading-5"><div><dt className="font-medium">Channel defaults only</dt><dd className="text-muted-foreground">These settings apply to new outreach that uses channel defaults.</dd></div><div><dt className="font-medium">Outreach-only messages</dt><dd className="text-muted-foreground">Messages configured in the composer belong to that reviewed outreach.</dd></div><div><dt className="font-medium">Saved campaign sequence</dt><dd className="text-muted-foreground">Campaigns keep the sequence revision saved at the time of sending.</dd></div></dl></section><section className="workspace-panel rounded-lg border bg-card p-4"><h2 className="text-sm font-semibold">{labels[channel]} checks</h2><p className="mt-3 text-xs leading-5 text-muted-foreground">Scheduling does not confirm eligibility. Recipient readiness, provider messaging windows and any required template approval are checked again before dispatch.</p><p className="mt-3 text-xs leading-5 text-muted-foreground">Assistant support check-ins belong to the receiving account and are configured in the published assistant.</p></section></div>
      </TabsContent>
      <TabsContent value="history"><FollowUpHistory key={channel} channel={channel} /></TabsContent>
      <TabsContent value="templates"><FollowUpTemplates key={channel} channel={channel} /></TabsContent>
    </Tabs>
  </div>;
}

export default function FollowUpsPage() {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading follow-ups…</div>}><FollowUpsContent /></Suspense>;
}
