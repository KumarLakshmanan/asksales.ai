'use client';
import { useState } from 'react';
import { canonicalizeTemplateVariable, extractTemplateVariables } from '../../../../../shared/templateVariables';
import type { AssistantResource } from '@/lib/outreach-assistants';
import { Input } from '@/components/ui/input';
import { Field } from './AssistantShared';

export function AssistantTemplatePreview({ template, channel }: { template?: AssistantResource; channel: string }) {
  const [samples, setSamples] = useState<Record<string, string>>({});
  if (!template) return null;
  const variables = [...new Set([...(template.variables || []), ...extractTemplateVariables(template.preview || '')])];
  const unknown = variables.filter(variable => !canonicalizeTemplateVariable(variable));
  const missing = variables.filter(variable => !samples[variable]?.trim());
  const text = (template.preview || '').replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g, (token, variable: string) => samples[variable] || token);
  return <details className="rounded-xl border bg-muted/20 p-4"><summary className="min-h-9 cursor-pointer text-sm font-medium">Preview {template.name} · {channel}</summary><div className="mt-3 space-y-4"><p className="text-xs leading-5 text-muted-foreground">Business status: {template.status || 'Approved in this catalog'}. Platform permission, messaging window and approval are checked again before delivery. This preview does not send a message.</p><div className="rounded-xl border bg-background p-4 text-sm leading-6 whitespace-pre-wrap break-words">{text || 'No message text preview is available for this template.'}</div>{variables.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{variables.map(variable => <Field key={variable} label={`Sample ${variable}`} htmlFor={`template-${template.id}-${variable}`}><Input id={`template-${template.id}-${variable}`} maxLength={200} autoComplete="off" value={samples[variable] || ''} placeholder="Enter a fictional example" onChange={e => setSamples({ ...samples, [variable]: e.target.value })} /></Field>)}</div>}{missing.length > 0 && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">Missing preview values: {missing.join(', ')}. Real delivery needs every permitted variable resolved.</p>}{unknown.length > 0 && <p role="alert" className="text-xs text-destructive">Unsupported variables: {unknown.join(', ')}. Repair the template before publishing a sequence.</p>}<p className="text-xs text-muted-foreground">Sample values stay in memory. Customer values are substituted only at the delivery boundary.</p></div></details>;
}
