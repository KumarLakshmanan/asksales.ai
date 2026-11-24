"use client";

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { WidgetProps } from './types';

export function WhatsappTemplateWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    template_name: String(widget.formValues.template_name || ''),
    category: String(widget.formValues.category || 'MARKETING'),
    language: String(widget.formValues.language || 'en_US'),
    header_text: String(widget.formValues.header_text || ''),
    body_text: String(widget.formValues.body_text || ''),
    footer_text: String(widget.formValues.footer_text || ''),
    cta_button_label: String(widget.formValues.cta_button_label || ''),
    cta_button_url: String(widget.formValues.cta_button_url || ''),
    quick_reply_buttons: (widget.formValues.quick_reply_buttons as string[]) || [],
  });
  useEffect(() => { onFormChange({ ...form, quick_reply_buttons: form.quick_reply_buttons.map(value => value.trim()).filter(Boolean) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);
  const field = (key: keyof typeof form, label: string, multiline = false) => (
    <div className="space-y-1.5" key={key}>
      <Label htmlFor={`whatsapp-${key}`} className="text-xs">{label}</Label>
      {multiline ? <Textarea id={`whatsapp-${key}`} value={String(form[key])} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
        : <Input id={`whatsapp-${key}`} value={String(form[key])} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />}
    </div>
  );
  return <div className="space-y-4">
    {field('template_name', 'Template name')}
    <div className="space-y-1.5">
      <Label className="text-xs">Category</Label>
      <Select value={form.category} onValueChange={category => setForm(f => ({ ...f, category }))}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{['MARKETING', 'UTILITY', 'AUTHENTICATION'].map(value => <SelectItem value={value} key={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {field('language', 'Language code')}
    {field('header_text', 'Header')}
    {field('body_text', 'Message', true)}
    {field('footer_text', 'Footer')}
    {field('cta_button_label', 'CTA button label')}
    {field('cta_button_url', 'CTA button URL')}
    <div className="space-y-1.5">
      <Label htmlFor="whatsapp-replies" className="text-xs">Quick replies (one per line, up to three)</Label>
      <Textarea id="whatsapp-replies" value={form.quick_reply_buttons.join('\n')} onChange={e => setForm(f => ({ ...f, quick_reply_buttons: e.target.value.split('\n') }))} />
    </div>
    <p className="text-xs text-muted-foreground">Creates a saved draft for review before submission to WhatsApp.</p>
  </div>;
}
