'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { instagramRuleFromTemplate, instagramRuleTemplates, type InstagramRuleDefinition } from '@/lib/instagram-automations';
import { Errors, Field, Section, selectClass } from './Fields';

export function TemplatePicker({ kind, follow, onApply }: { kind: InstagramRuleDefinition['kind']; follow: boolean; onApply: (value: InstagramRuleDefinition) => void }) {
  const [template, setTemplate] = useState('guide'), [link, setLink] = useState(''), [hours, setHours] = useState(''), [error, setError] = useState('');
  const chosen = instagramRuleTemplates.find(value => value.id === template)!;
  return <Section title="Start from a template" description="Add your details, then customize every field before saving.">
    <Field label="Automation template"><select className={selectClass} value={template} onChange={event => { setTemplate(event.target.value); setError(''); }}>{instagramRuleTemplates.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select></Field>
    <p className="text-xs text-muted-foreground">{chosen.description}</p>
    {chosen.needsLink ? <Field label="Your content link"><Input type="url" placeholder="https://your-website.com/…" value={link} onChange={event => setLink(event.target.value)} /></Field> : <Field label="Your opening hours"><Input placeholder="Monday–Friday, 9 am–6 pm" value={hours} onChange={event => setHours(event.target.value)} /></Field>}
    <Errors errors={error ? [error] : []} />
    <Button type="button" variant="outline" onClick={() => { try { onApply(instagramRuleFromTemplate(template, kind, link, hours, follow)); setError(''); } catch (cause) { setError((cause as Error).message); } }}>Use template</Button>
  </Section>;
}
