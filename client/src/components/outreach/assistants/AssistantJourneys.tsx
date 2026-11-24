"use client";

import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { AssistantPlaybookPreview } from './AssistantPlaybookPreview';
import { AssistantResourceSelection } from './AssistantResourceSelection';
import { AssistantToolSelection } from './AssistantToolSelection';
import { AssistantPlaybookPicker } from './AssistantJourneyPickers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { assistantChannelLabels, resourceSupportsChannel, type AssistantChannel } from '@/lib/outreach-assistants';
import type { AssistantPanelProps } from './AssistantConfiguration';
import { ConfigurationSection, Field, nativeSelectClass } from './AssistantShared';

export function PlaybooksConfiguration({ draft, catalog, onChange }: AssistantPanelProps) {
  const playbooks = catalog.playbooks.filter(playbook => !playbook.agentType || playbook.agentType === draft.agentType);
  const channels = [...new Set(draft.bindings.map(binding => binding.channel))];
  return <ConfigurationSection title="Published playbooks" description="Assign compatible customer journeys by channel, surface and intent. A new session starts a fresh run while the CRM retains earlier history." action={<Button variant="outline" asChild><Link href="/dashboard/settings/outreach/playbooks">Manage playbooks</Link></Button>}><div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4"><p className="text-sm text-muted-foreground">{playbookCountLabel(draft.playbooks.assignments)}</p><AssistantPlaybookPicker draft={draft} catalog={catalog} onChange={onChange} /></div>{draft.playbooks.mode !== 'none' && <Button type="button" variant="ghost" className="mb-4" onClick={() => onChange({ ...draft, playbooks: { mode: 'none', assignments: [] } })}>Use none</Button>}{draft.playbooks.mode === 'selected' && <div className="space-y-5">{draft.playbooks.assignments.map((assignment, index) => {
    const playbook = playbooks.find(item => item.id === assignment.playbookId);
    const possibleChannels = channels.filter(channel => !playbook || resourceSupportsChannel(playbook, channel));
    return <div key={index} className="space-y-4 border-b pb-5"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{playbook?.name || `Unavailable playbook ${assignment.playbookId}`}</h3>{!playbook && <p className="mt-1 text-xs text-destructive">This published playbook is no longer compatible or available.</p>}</div><Button type="button" variant="ghost" aria-label={`Remove playbook assignment ${index + 1}`} onClick={() => onChange({ ...draft, playbooks: { ...draft.playbooks, assignments: draft.playbooks.assignments.filter((_, at) => at !== index) } })}><Trash2 className="h-4 w-4" /></Button></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Field label="Channel" htmlFor={`playbook-channel-${index}`}><select id={`playbook-channel-${index}`} className={nativeSelectClass} value={assignment.channel} onChange={event => onChange({ ...draft, playbooks: { ...draft.playbooks, assignments: draft.playbooks.assignments.map((item, at) => at === index ? { ...item, channel: event.target.value as AssistantChannel, surface: 'private' } : item) } })}>{!possibleChannels.includes(assignment.channel) && <option value={assignment.channel}>{assistantChannelLabels[assignment.channel]} · Not assigned</option>}{possibleChannels.map(channel => <option key={channel} value={channel}>{assistantChannelLabels[channel]}</option>)}</select></Field><Field label="Surface" htmlFor={`playbook-surface-${index}`}><select id={`playbook-surface-${index}`} className={nativeSelectClass} value={assignment.surface} onChange={event => onChange({ ...draft, playbooks: { ...draft.playbooks, assignments: draft.playbooks.assignments.map((item, at) => at === index ? { ...item, surface: event.target.value as 'private' | 'public_comment' } : item) } })}><option value="private">Private messages</option>{(['instagram', 'facebook'].includes(assignment.channel) || assignment.surface === 'public_comment') && <option value="public_comment">Public comments</option>}</select></Field><Field label="Intent (optional)" htmlFor={`playbook-intent-${index}`} hint="Blank applies to any compatible intent."><Input id={`playbook-intent-${index}`} maxLength={80} value={assignment.intent || ''} onChange={event => onChange({ ...draft, playbooks: { ...draft.playbooks, assignments: draft.playbooks.assignments.map((item, at) => at === index ? { ...item, intent: event.target.value.trim() || null } : item) } })} /></Field><Field label="Priority" htmlFor={`playbook-priority-${index}`}><Input id={`playbook-priority-${index}`} type="number" min={0} max={10000} step={1} value={assignment.priority} onChange={event => onChange({ ...draft, playbooks: { ...draft.playbooks, assignments: draft.playbooks.assignments.map((item, at) => at === index ? { ...item, priority: Number(event.target.value) } : item) } })} /></Field></div>{playbook?.collectionFields?.length ? <p className="text-xs text-muted-foreground">Permitted collection fields: {playbook.collectionFields.join(', ')}. Enable only the fields you need under Privacy & policies.</p> : null}</div>;
  })}{!playbooks.length && <p className="text-sm text-muted-foreground">No compatible published playbooks are available for this preset.</p>}{!channels.length && <p className="text-sm text-muted-foreground">Assign a receiving account first to choose its channel.</p>}</div>}<AssistantPlaybookPreview draft={draft} catalog={catalog} /></ConfigurationSection>;
}

export function ToolsConfiguration({ draft, catalog, onChange }: AssistantPanelProps) {
  return <div className="ak-panel-stack"><ConfigurationSection title="Permitted tools" description="Choose the actions this assistant may take. Required approvals stay enabled."><AssistantToolSelection draft={draft} catalog={catalog} onChange={onChange} /></ConfigurationSection>
    <ConfigurationSection title="Brochures & documents" description="Only explicitly selected approved documents can be delivered. A published knowledge source is not automatically a customer-downloadable PDF."><AssistantResourceSelection category="documents" label="Brochures & documents" resources={catalog.documents} unavailableResources={catalog.unavailableResources?.filter(resource => resource.category === 'documents')} value={draft.documents} onChange={documents => onChange({ ...draft, documents })} /></ConfigurationSection>
    <ConfigurationSection title="Galleries" description="The assistant may use only selected approved galleries and permitted media."><AssistantResourceSelection category="galleries" label="Galleries" resources={catalog.galleries} unavailableResources={catalog.unavailableResources?.filter(resource => resource.category === 'galleries')} value={draft.galleries} onChange={galleries => onChange({ ...draft, galleries })} /></ConfigurationSection>
  </div>;
}

export { FollowUpsConfiguration } from './AssistantFollowUpConfiguration';

export function playbookCountLabel(assignments: { playbookId: number }[]): string {
  const playbooks = new Set(assignments.map(a => a.playbookId)).size;
  const routes = assignments.length;
  return `${playbooks} ${playbooks === 1 ? 'playbook' : 'playbooks'} assigned${routes > playbooks ? ` · ${routes} routes` : ''}`;
}
