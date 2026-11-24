"use client";

import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bold, Heading2, ImagePlus, List, Plus, Table2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ProposalMarkdown } from './ProposalDocument';
import type { ProposalSection } from '../../../../shared/proposals';

export function ProposalTextEditor({ id, label, value, onChange, rows = 7 }: { id: string; label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false), [imageUrl, setImageUrl] = useState(''), [showImage, setShowImage] = useState(false);
  const insert = (before: string, after = '', fallback = 'Text') => {
    const start = field.current?.selectionStart ?? value.length, end = field.current?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    onChange(`${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`);
    setPreview(false);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(start + before.length, start + before.length + selected.length); });
  };
  return <div className="space-y-2"><label htmlFor={id} className="text-sm font-medium">{label}</label><div className="overflow-hidden rounded-lg border bg-background">
    <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 p-1" role="toolbar" aria-label={`${label} formatting`}>
      {[{icon: Heading2, label: 'Insert heading', before: '\n## ', after: '\n'}, {icon: Bold, label: 'Bold text', before: '**', after: '**'}, {icon: List, label: 'Insert bullet list', before: '\n- ', after: '\n'}, {icon: Table2, label: 'Insert table', before: '\n', after: '\n', fallback: '| Deliverable | Details |\n| --- | --- |\n| Item | Description |'}].map(action => <Button key={action.label} type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label={action.label} title={action.label} onClick={() => insert(action.before, action.after, action.fallback)}><action.icon className="h-4 w-4" /></Button>)}
      <Button type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label="Insert image" title="Insert image" onClick={() => setShowImage(!showImage)}><ImagePlus className="h-4 w-4" /></Button>
      <Button type="button" variant="ghost" className="ml-auto h-10" onClick={() => setPreview(!preview)} aria-pressed={preview}>{preview ? 'Edit text' : 'Preview formatting'}</Button>
    </div>
    {showImage && <div className="flex flex-wrap gap-2 border-b p-2"><Input aria-label="Image HTTPS address" placeholder="https://…" value={imageUrl} onChange={event => setImageUrl(event.target.value)} className="flex-1" /><Button type="button" variant="outline" disabled={!/^https:\/\/[^\s)]+$/.test(imageUrl)} onClick={() => { insert('\n![', `](${imageUrl})\n`, 'Describe the image'); setShowImage(false); setImageUrl(''); }}>Insert image</Button></div>}
    {preview ? <div className="proposal-paper border-0 p-4"><ProposalMarkdown>{value || 'No text yet.'}</ProposalMarkdown></div> : <Textarea ref={field} id={id} value={value} onChange={event => onChange(event.target.value)} rows={rows} className="rounded-none border-0 text-sm leading-6 shadow-none" />}
    <p className="border-t px-3 py-1 text-xs text-muted-foreground">Headings, lists, tables and images use Markdown.</p>
  </div></div>;
}

export function ProposalSectionEditor({ sections, onChange, reusable = [] }: { sections: ProposalSection[]; onChange: (sections: ProposalSection[]) => void; reusable?: ProposalSection[] }) {
  const update = (index: number, data: Partial<ProposalSection>) => onChange(sections.map((item, i) => i === index ? { ...item, ...data } : item));
  const move = (index: number, offset: number) => { const next = [...sections]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange(next); };
  return <div className="space-y-5">
    {sections.map((section, index) => <section key={index} className="space-y-3 rounded-xl border bg-card p-4" aria-label={`Section ${index + 1}: ${section.title}`}>
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><Input aria-label={`Section ${index + 1} title`} value={section.title} onChange={event => update(index, { title: event.target.value })} className="min-w-40 flex-1" />
        <select aria-label={`Section ${index + 1} type`} value={section.kind} onChange={event => update(index, {kind: event.target.value as ProposalSection['kind']})} className="h-10 rounded-md border bg-background px-2 text-sm">{['cover', 'content', 'terms', 'closing'].map(kind => <option key={kind}>{kind}</option>)}</select>
        <Button type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label={`Move section ${index + 1} up`} title={index === 0 ? 'Already the first section' : 'Move section up'} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label={`Move section ${index + 1} down`} title={index === sections.length - 1 ? 'Already the last section' : 'Move section down'} disabled={index === sections.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label={`Remove section ${index + 1}`} onClick={() => onChange(sections.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button>
      </div>
      {section.instruction && <details className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Writing guidance · visible only to your team</summary><p className="mt-2 whitespace-pre-wrap">{section.instruction}</p></details>}
      <ProposalTextEditor id={`proposal-section-${index}`} label="Customer-facing content" value={section.body} onChange={body => update(index, { body })} />
    </section>)}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => onChange([...sections, {title: 'New section', body: '', kind: 'content'}])}><Plus className="mr-2 h-4 w-4" />Add section</Button>
      {!!reusable.length && <select aria-label="Insert reusable template section" value="" onChange={event => { if (event.target.value !== '') onChange([...sections, {...reusable[Number(event.target.value)]}]); }} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="">Insert a reusable section…</option>{reusable.map((section, i) => <option key={i} value={i}>{section.title}</option>)}</select>}
    </div>
  </div>;
}
