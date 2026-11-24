'use client';

import { ArrowRight, CircleHelp, List, MessageCircle, Send, UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { instagramCardConnection, type InstagramAutomationOverview } from '@/lib/instagram-automations';
import type { AutomationNavigation } from './AutomationHub';
import { AutomationDemo } from './AutomationDemo';

const automations = [
  {
    id: 'icebreakers', title: 'Conversation starters', icon: CircleHelp,
    description: 'Give new visitors a few questions to choose from when they open your DMs.',
    action: 'Set up questions', navigation: { view: 'icebreakers' },
  },
  {
    id: 'menu', title: 'Main menu', icon: List,
    description: 'Keep your website, pricing and saved answers in the menu inside your DMs.',
    action: 'Set up menu', navigation: { view: 'menu' },
  },
  {
    id: 'comment_dm', title: 'Comment to DM', icon: Send,
    description: 'Send a private message when someone comments a keyword on your post or reel.',
    action: 'Create comment to DM', navigation: { view: 'new', kind: 'comment_dm', guided: true },
  },
  {
    id: 'comment_reply', title: 'Public comment reply', icon: MessageCircle,
    description: 'Answer matching comments with a public reply below the same post or reel.',
    action: 'Create public reply', navigation: { view: 'new', kind: 'comment_reply' },
  },
  {
    id: 'follow', title: 'Follow to unlock', icon: UserCheck,
    description: 'Ask a commenter to follow you, then verify their follow before sending the promised content.',
    action: 'Set up follow verification', navigation: { view: 'new', kind: 'comment_dm', guided: true, preset: 'follow' },
  },
] as const;

export function AutomationCatalog({ data, onNavigate }: {
  data: InstagramAutomationOverview;
  onNavigate: (navigation: AutomationNavigation) => void;
}) {
  return (
    <section aria-label="Available automations" className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {automations.map(item => {
        const profile = data.profiles.find(value => value.kind === item.id);
        const rules = data.rules.filter(rule => item.id === 'follow'
          ? rule.definition.kind === 'comment_dm' && rule.definition.followGate.enabled
          : rule.definition.kind === item.id && (item.id !== 'comment_dm' || !rule.definition.followGate.enabled));
        const active = rules.filter(rule => rule.status === 'active').length;
        const status = profile
          ? profile.syncStatus === 'syncing' || profile.syncStatus === 'reconciling' ? 'Verifying'
            : profile.syncStatus === 'published' ? 'Published'
              : profile.syncStatus === 'error' ? 'Needs attention' : 'Draft saved'
          : active ? `${active} active` : rules.length ? `${rules.length} saved` : 'Not set up';
        const live = status === 'Published' || active > 0;
        const hasDraftChanges = !!profile?.publishedConfig && JSON.stringify(profile.config) !== JSON.stringify(profile.publishedConfig);
        const connection = instagramCardConnection(data.readiness, item.id);
        return (
          <article key={item.id} aria-labelledby={`automation-${item.id}`} className="group flex min-w-0 flex-col rounded-2xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-primary"><item.icon aria-hidden="true" className="h-5 w-5" /></div>
              <Badge variant="outline" className={live ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}>{status}</Badge>
            </div>
            <h2 id={`automation-${item.id}`} className="mt-5 text-lg font-semibold tracking-tight">{item.title}</h2>
            <p className="mt-2 min-h-[4.5rem] text-sm leading-6 text-muted-foreground">{item.description}</p>
            <div className="mt-3 space-y-1 text-xs leading-5"><p className={connection.ready ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'font-medium'}>{connection.label}</p>{!connection.ready && <p className="text-muted-foreground">{connection.detail} Drafts remain available.</p>}{(rules.length > 0 || hasDraftChanges) && <p className="text-muted-foreground">{rules.length ? `${rules.filter(rule => rule.status === 'paused').length} paused` : ''}{hasDraftChanges ? ' · Unpublished changes' : ''}</p>}</div>
            <AutomationDemo kind={item.id} username={data.account.username || 'your_business'} />
            <Button variant="outline" className="w-full justify-between gap-2" onClick={() => onNavigate(item.navigation)}>
              {profile ? `Edit ${item.id === 'menu' ? 'menu' : 'questions'}` : item.action}<ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            </Button>
            {rules.length > 0 && <Button variant="link" className="mt-2 h-auto min-h-9 whitespace-normal text-xs" onClick={() => onNavigate({ view: 'rules', kind: item.id === 'comment_reply' ? 'comment_reply' : 'comment_dm', ...(item.id === 'follow' ? { preset: 'follow' } : item.id === 'comment_dm' ? { preset: 'standard' } : {}) })}>Manage {rules.length} saved {rules.length === 1 ? 'automation' : 'automations'}</Button>}
          </article>
        );
      })}
    </section>
  );
}
