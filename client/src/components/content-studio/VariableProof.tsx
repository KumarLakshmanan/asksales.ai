"use client";
import { useState } from 'react';

export function VariableProof({ text }: { text: string }) {
  const [samples, setSamples] = useState<Record<string, string>>({});
  const variables = Array.from(new Set(Array.from(text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g), (match) => match[1])));
  if (!variables.length) return null;
  const unresolved = variables.filter((name) => !samples[name]?.trim());
  const rendered = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (original, name: string) => samples[name] || original);
  return <details className="border-t border-border p-4 text-xs">
    <summary className="cursor-pointer font-medium">Variable proof · {variables.length} field{variables.length === 1 ? '' : 's'}</summary>
    <p className="my-2 text-muted-foreground">Preview-only examples. Actual recipient values are checked in outreach before sending.</p>
    <div className="grid gap-2 sm:grid-cols-2">{variables.map((name) => <label key={name} className="space-y-1"><span>{name}</span><input aria-label={`Sample ${name}`} value={samples[name] || ''} onChange={(event) => setSamples({ ...samples, [name]: event.target.value })} className="block w-full rounded border border-border bg-background p-2" /></label>)}</div>
    {unresolved.length > 0 && <p className="mt-2 text-amber-700 dark:text-amber-400">Missing examples: {unresolved.join(', ')}</p>}
    <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3">{rendered}</p>
  </details>;
}
