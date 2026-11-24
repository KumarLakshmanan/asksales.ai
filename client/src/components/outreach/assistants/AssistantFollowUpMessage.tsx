"use client";

import { assistantAiFollowUpAvailable, type AssistantChannel, type AssistantFollowUps, type AssistantResource } from '@/lib/outreach-assistants';
import { AssistantFollowUpTemplatePicker } from './AssistantJourneyPickers';
import { Field, nativeSelectClass } from './AssistantShared';

type Step = AssistantFollowUps['sequences'][number]['steps'][number];
export function AssistantFollowUpMessage({ step, channel, index, id, template, onChange }: {
  step: Step; channel: AssistantChannel; index: number; id: string; template?: AssistantResource; onChange: (step: Step) => void;
}) {
  const aiAvailable = assistantAiFollowUpAvailable(channel, step.delayMinutes);
  const ai = step.messageMode === 'ai';
  const explanation = !aiAvailable
    ? 'Choose a valid email delay, or a WhatsApp delay under 24 hours. Shorten the delay or choose an approved template.'
    : channel === 'email'
      ? 'Writes a brief follow-up using this conversation and the assistant’s reply model. Uses your assistant email design and original sending account. A customer reply or human takeover stops remaining messages.'
      : 'Creates a brief check-in using this conversation and the assistant’s reply model. Sends only while the 24-hour window from the customer’s last message is still open; otherwise skips the check-in.';
  return <div className="space-y-3"><Field label={`Message ${index + 1} content`} htmlFor={`follow-up-content-${id}`}><select id={`follow-up-content-${id}`} className={nativeSelectClass} value={ai ? 'ai' : 'template'} onChange={event => onChange({ ...step, messageMode: event.target.value as 'ai' | 'template', templateId: 0 })}><option value="template">Approved template</option>{(aiAvailable || ai) && <option value="ai" disabled={!aiAvailable}>AI-generated reply</option>}</select></Field>
    {ai ? <p className={`text-xs leading-6 ${aiAvailable ? 'text-muted-foreground' : 'text-destructive'}`} role={aiAvailable ? undefined : 'alert'}>{explanation}</p> : <><AssistantFollowUpTemplatePicker channel={channel} template={template} label={`Message ${index + 1} template`} onChange={templateId => onChange({ ...step, templateId })} />{!template && <p className="text-xs text-amber-700 dark:text-amber-400">Choose an approved template before saving, or use an AI reply when available.</p>}</>}
  </div>;
}
