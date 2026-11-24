"use client";

import type { SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ChannelMessageEditor } from '../ChannelMessageEditor';
import { WhatsAppTemplateEditor } from './WhatsAppTemplateEditor';
import type { InboxChannel } from '../../../../../shared/outreachInbox';
import type { OutreachTemplate } from '../../../../../shared/outreachCompose';
import { localFollowUpMinutes, type OutreachLocalFollowUps, type OutreachFollowUpDraft } from '../../../../../shared/outreachLocalFollowUps';

export function OutreachFollowUpEditor({ channel, value, onChange, templates, providerAccountId, loadingTemplates }: {
  channel: InboxChannel; value: OutreachLocalFollowUps; onChange: (value: SetStateAction<OutreachLocalFollowUps>) => void;
  templates: OutreachTemplate[]; providerAccountId?: string; loadingTemplates?: boolean;
}) {
  const update = (id: string, patch: Partial<OutreachFollowUpDraft>) => onChange(current => ({ ...current, steps: current.steps.map(step => step.id === id ? { ...step, ...patch } : step) }));
  const add = () => onChange({ enabled: true, steps: [...value.steps, {
    id: crypto.randomUUID(), delayValue: value.steps.length ? localFollowUpMinutes(value.steps[value.steps.length - 1]) + 1440 : 1440,
    delayUnit: 'minutes', message: '', subject: '', templateId: '', templateValues: {},
  }] });
  return <section aria-label="Follow-ups for this outreach" className="space-y-4 rounded-md border p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Follow-ups for this outreach</h3>
      <Switch aria-label="Enable follow-ups for this outreach" checked={value.enabled} onCheckedChange={enabled => { if (enabled && !value.steps.length) add(); else onChange({ ...value, enabled }); }} />
    </div>
    <p className="text-xs leading-5 text-muted-foreground">These messages and timings apply only to this outreach. Your channel defaults stay unchanged. Each delay starts from the initial message; follow-ups stop when the recipient replies.</p>
    {value.enabled ? <>
      {value.steps.map((step, index) => <fieldset key={step.id} className="min-w-0 space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Follow-up {index + 1}</legend>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Delay<Input className="mt-1 w-24" aria-label={`Follow-up ${index + 1} delay`} type="number" min={1} value={step.delayValue} onChange={event => update(step.id, { delayValue: Number(event.target.value) })} /></label>
          <label className="text-xs">Unit<select className="mt-1 block h-10 rounded-md border bg-background px-2" aria-label={`Follow-up ${index + 1} delay unit`} value={step.delayUnit} onChange={event => update(step.id, { delayUnit: event.target.value as OutreachFollowUpDraft['delayUnit'] })}>
            <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
          </select></label>
          <Button type="button" variant="ghost" onClick={() => onChange({ ...value, steps: value.steps.filter(item => item.id !== step.id) })}>Remove follow-up {index + 1}</Button>
        </div>
        {channel === 'whatsapp' ? <WhatsAppTemplateEditor prefix={`follow-up-${step.id}`} templates={templates} templateId={step.templateId} values={step.templateValues} providerAccountId={providerAccountId} loading={loadingTemplates}
          onTemplateChange={templateId => update(step.id, { templateId })} onValuesChange={templateValues => update(step.id, { templateValues })} />
          : <>{channel === 'email' && <Input aria-label={`Follow-up ${index + 1} subject`} placeholder="Subject (optional; uses initial subject)" value={step.subject} onChange={event => update(step.id, { subject: event.target.value })} />}
            <ChannelMessageEditor channel={channel} value={step.message} label={`Follow-up ${index + 1} message`} onChange={message => update(step.id, { message })} placeholder="Write a follow-up. You can use {{first_name}} and {{company_name}}." />
          </>}
      </fieldset>)}
      <Button type="button" variant="outline" disabled={value.steps.length >= 10} onClick={add}>Add follow-up</Button>
    </> : <p className="text-xs text-muted-foreground">No automatic follow-ups for this outreach.</p>}
  </section>;
}
