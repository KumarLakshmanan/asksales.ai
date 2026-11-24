"use client";

import Link from 'next/link';
import { DOCUMENT_TOPICS } from '@/lib/support-documents';

export function SupportDocumentStepEditor({ args, onChange, readOnly }: {
  args: unknown; onChange: (args: Record<string, unknown>) => void; readOnly: boolean;
}) {
  const bindings = (args || {}) as { service?: { value?: string } };
  return <fieldset className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
    <legend className="px-1 text-sm font-medium">Find and share a document</legend>
    <label className="block space-y-1 text-xs">Document topic
      <select aria-label="Document topic" disabled={readOnly} value={bindings.service?.value || ''}
        onChange={event => onChange({ service: { source: 'constant', value: event.target.value } })}
        className="h-10 w-full rounded-md border bg-background px-2 text-sm">
        <option value="" disabled>Choose a topic</option>{DOCUMENT_TOPICS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <p className="text-xs text-muted-foreground">AI automatically searches approved documents for this topic and the customer’s request. No document linking is needed. Newly approved files are available without editing this playbook.</p>
    <p className="text-xs text-muted-foreground">If no document matches, the agent explains that and offers to connect the customer to support. Only current, approved PDFs in this conversation’s business scope can be shared through WhatsApp or secure webchat downloads.</p>
    {!readOnly && <Link href="/dashboard/knowledge-base/documents" className="inline-block text-xs font-medium text-primary underline underline-offset-4">Manage documents</Link>}
  </fieldset>;
}
