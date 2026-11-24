'use client';
import Link from 'next/link';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import type { AssistantAssignmentHealth } from '../../../../../shared/assistantOperations';
import { assistantBindingKey } from '@/lib/outreach-assistants';
import { Button } from '@/components/ui/button';
import { ChannelBadge, StateBadge } from './AssistantShared';

/** One health display is shared by settings and operations, including mobile. */
export function AssistantAssignmentRows({ accounts }: { accounts: AssistantAssignmentHealth[] }) {
  return <div className="ak-assignment-list"><div className="ak-assignment-heading" aria-hidden="true"><span>Account</span><span>Channel &amp; surface</span><span>Connection</span><span>Assistant / published revision</span><span>State</span><span>Actions</span></div>{accounts.map(item => {
    const state = item.state === 'live' && (!item.connected || !item.runtimeEnabled || !item.revision || item.checks.some(check=>!check.ok)) ? 'needs_attention' : item.state;
    return <article key={assistantBindingKey(item)} className="ak-assignment-row">
      <div><p className="break-words text-sm font-semibold">{item.label}</p><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{item.accountId}</p></div>
      <div><ChannelBadge channel={item.channel} publicComment={item.surface === 'public_comment'} /><p className="mt-2 text-xs text-muted-foreground">{item.surface === 'public_comment' ? 'Public comments' : 'Private messages'}</p></div>
      <div><p className={`flex items-start gap-2 text-xs leading-5 ${item.connected ? 'text-muted-foreground' : 'text-destructive'}`}><span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.connected ? 'bg-emerald-600' : 'bg-destructive'}`} />{item.connected ? 'Connected' : 'Disconnected · Reconnect this verified account'}</p></div>
      <div><p className="break-words text-sm font-medium">{item.assistantName || 'No assistant assigned'}</p><p className="mt-1 text-xs text-muted-foreground">{item.revision ? `Published revision ${item.revision}` : 'No published configuration'}{!item.runtimeEnabled && ' · Assistant routing disabled'}</p></div>
      <div>{state !== 'unassigned' ? <StateBadge state={state} /> : <span className="rounded border px-2 py-1 text-xs">Unassigned</span>}</div>
      <div className="flex flex-wrap items-start gap-2">{item.assistantId && <Button asChild variant="outline" size="sm"><Link href={`/dashboard/settings/outreach/assistants/${encodeURIComponent(item.assistantId)}`}>Review assistant</Link></Button>}{!item.connected && <Button asChild variant="outline" size="sm"><Link href={item.channel === 'web' ? '/dashboard/support-ai/embed' : `/dashboard/integrations/${item.channel}?accountId=${encodeURIComponent(item.accountId)}`}>Manage connection</Link></Button>}</div>
      <details className="ak-assignment-checks text-xs"><summary className="min-h-11 cursor-pointer py-3 font-medium text-primary">Readiness details · {item.checks.length ? item.checks.some(check=>!check.ok) ? 'Needs attention' : 'All recorded checks passed' : 'No checks recorded'}</summary><ul className="space-y-2 pb-3">{item.checks.map(check => <li key={check.key} className="flex items-start gap-3 rounded-lg bg-card px-3">{check.ok ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}<span className="min-w-0 flex-1"><span className="font-medium">{check.label}</span><span className="mt-1 block leading-5 text-muted-foreground">{check.detail}</span></span><span className={check.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>{check.ok ? 'Passed' : 'Needs attention'}</span></li>)}</ul></details>
    </article>;
  })}</div>;
}
