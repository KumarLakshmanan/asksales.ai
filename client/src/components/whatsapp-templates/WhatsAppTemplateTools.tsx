"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WhatsAppAuthConfig } from "./templateData";
import { CheckCircle2, CircleAlert, FileText, LayoutGrid, Sparkles } from "lucide-react";

export const defaultWhatsAppAuth: WhatsAppAuthConfig = { otpType: "COPY_CODE", buttonText: "Copy code", codeExpirationMinutes: 10, addSecurityRecommendation: true };

export function whatsappAuthErrors(value: WhatsAppAuthConfig): string[] {
  const errors: string[] = [];
  if (!value.buttonText.trim() || value.buttonText.length > 25) errors.push("Add an OTP button label of up to 25 characters.");
  if (!Number.isInteger(value.codeExpirationMinutes) || value.codeExpirationMinutes < 1 || value.codeExpirationMinutes > 90) errors.push("Choose an expiration between 1 and 90 minutes.");
  if (value.otpType === "ONE_TAP") {
    if (!value.autofillText?.trim() || value.autofillText.length > 25) errors.push("Add an autofill label of up to 25 characters.");
    if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(value.packageName || "")) errors.push("Enter your Android app package, such as com.example.app.");
    if (!/^[A-Za-z0-9+/=]{11}$/.test(value.signatureHash || "")) errors.push("Enter the 11-character Android app signature hash.");
  }
  return errors;
}

const input = "mt-1 min-h-11 w-full rounded-lg border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
export function WhatsAppAuthenticationEditor({ value, onChange, disabled }: { value: WhatsAppAuthConfig; onChange(value: WhatsAppAuthConfig): void; disabled: boolean }) {
  const set = (patch: Partial<WhatsAppAuthConfig>) => onChange({ ...value, ...patch });
  return <section id="whatsapp-auth" className="rounded-xl border bg-card p-5" aria-label="Authentication settings">
    <h2 className="font-semibold">Verification code settings</h2>
    <p className="mt-1 text-sm text-muted-foreground">WhatsApp supplies the verification message. Configure its code button and expiration; promotional text and media are unavailable for this category.</p>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Code button<select aria-label="OTP button type" value={value.otpType} disabled={disabled} onChange={event => set({ otpType: event.target.value as WhatsAppAuthConfig["otpType"] })} className={input}><option value="COPY_CODE">Copy code</option><option value="ONE_TAP">Android one-tap autofill</option></select></label>
      <label className="text-sm">Copy button label<input id="whatsapp-auth-button" aria-label="OTP button label" value={value.buttonText} maxLength={25} disabled={disabled} onChange={event => set({ buttonText: event.target.value })} className={input} /></label>
      <label className="text-sm">Code expiration (minutes)<input id="whatsapp-auth-expiration" aria-label="Code expiration minutes" type="number" min={1} max={90} value={value.codeExpirationMinutes} disabled={disabled} onChange={event => set({ codeExpirationMinutes: Number(event.target.value) })} className={input} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.addSecurityRecommendation} disabled={disabled} onChange={event => set({ addSecurityRecommendation: event.target.checked })} />Include the security reminder</label>
      {value.otpType === "ONE_TAP" && <>
        <label className="text-sm">Autofill button label<input id="whatsapp-auth-autofill" aria-label="Autofill button label" value={value.autofillText || ""} maxLength={25} disabled={disabled} onChange={event => set({ autofillText: event.target.value })} className={input} /></label>
        <label className="text-sm">Android package name<input id="whatsapp-auth-package" aria-label="Android package name" value={value.packageName || ""} disabled={disabled} onChange={event => set({ packageName: event.target.value })} placeholder="com.example.app" className={input} /></label>
        <label className="text-sm">App signature hash<input id="whatsapp-auth-signature" aria-label="App signature hash" value={value.signatureHash || ""} disabled={disabled} onChange={event => set({ signatureHash: event.target.value })} className={input} /></label>
        <p className="text-xs text-muted-foreground">Your Android app must implement WhatsApp OTP autofill. Copy-code fallback remains available.</p>
      </>}
    </div>
  </section>;
}

export function WhatsAppOptionalSection({ title, expanded = false, children }: { title: string; expanded?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (expanded && ref.current) ref.current.open = true; }, [expanded]);
  return <details ref={ref} className="rounded-xl border bg-card"><summary className="cursor-pointer rounded-xl px-5 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{title}<span className="ml-2 font-normal text-muted-foreground">Optional</span></summary><div className="px-3 pb-3">{children}</div></details>;
}

export function WhatsAppCreationChoices({ onBlank, onPattern, onAI, disabled }: { onBlank(): void; onPattern(): void; onAI(): void; disabled: boolean }) {
  return <div className="mb-4 grid gap-2 sm:grid-cols-3" aria-label="Choose how to start">
    {[{title:'Start blank',description:'Write your own message',action:onBlank,icon:FileText}, {title:'Use a pattern',description:'Customize a ready-made message',action:onPattern,icon:LayoutGrid}, {title:'Generate with AI',description:'Describe what you want to say',action:onAI,icon:Sparkles}].map(({title, description, action, icon: Icon}) => <button key={title} type="button" disabled={disabled} onClick={action} className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"><span className="workspace-section-icon"><Icon className="h-4 w-4" /></span><span><span className="block text-sm font-semibold">{title}</span><span className="mt-1 block text-xs text-muted-foreground">{description}</span></span></button>)}
  </div>;
}

export function WhatsAppReadiness({ requirements, complete, variableCount, onFocus }: { requirements: {label: string; field: string}[]; complete: boolean; variableCount: number; onFocus(field: string): void }) {
  const groups = [
    {label:'Template name', matches:(field: string) => field === 'whatsapp-template-name'},
    {label:'Language and category', matches:(field: string) => field === 'whatsapp-language'},
    {label:'Message content', matches:(field: string) => field === 'whatsapp-body' || field.startsWith('whatsapp-auth')},
    {label:'Media, buttons and examples', matches:(field: string) => !['whatsapp-template-name','whatsapp-language','whatsapp-body'].includes(field) && !field.startsWith('whatsapp-auth')},
  ];
  return <section className="overflow-hidden rounded-lg border bg-card" aria-label="Template readiness"><h2 className="border-b px-4 py-3 text-sm font-semibold">Template readiness</h2><ul className="space-y-3 p-4">{groups.map(group => { const issue = requirements.find(item => group.matches(item.field)); return <li key={group.label} className="flex items-start gap-2.5 text-xs leading-5">{issue ? <><CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><button type="button" aria-label={`Fix template readiness: ${issue.label}`} onClick={() => onFocus(issue.field)} className="text-left text-primary underline underline-offset-2">{issue.label}</button></> : <><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>{group.label} complete</span></>}</li>; })}</ul><p className="mx-4 border-t py-3 text-xs leading-5 text-muted-foreground">{variableCount ? `${variableCount} variable ${variableCount === 1 ? 'example' : 'examples'}` : 'Variables: none · optional'}{complete ? ' · Ready for review' : ' · Save unfinished work as a draft'}</p></section>;
}

export function WhatsAppChecklist({ requirements, onFocus }: { requirements: { label: string; field: string }[]; onFocus(field: string): void }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="my-4 rounded-xl border bg-card p-4" aria-label="Submission checklist"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Submission checklist</h2><button type="button" className="text-xs text-primary underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide checklist' : `View checklist${requirements.length ? ` (${requirements.length})` : ''}`}</button></div>
    <p className="mt-1 text-xs text-muted-foreground">{requirements.length ? 'You can save unfinished work as a draft. Complete these items before approval submission.' : 'Message fields are complete. Check the account and preview before submitting.'}</p>
    {expanded && <ul className="mt-3 space-y-2">{requirements.length ? requirements.map(item => <li key={item.field}><button type="button" onClick={() => onFocus(item.field)} className="text-left text-sm text-primary underline">{item.label}</button></li>) : <li className="text-sm text-emerald-700 dark:text-emerald-300">All message requirements complete</li>}</ul>}
  </section>;
}

export function WhatsAppAICandidate({ body, header, error, onApply, onDiscard, onRegenerate }: { body: string; header?: string; error?: string; onApply(): void; onDiscard(): void; onRegenerate(): void }) {
  return <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4"><h3 className="text-sm font-semibold">Review generated copy</h3><p className="mt-1 text-xs text-muted-foreground">Your existing message stays unchanged until you apply this suggestion.</p>{header && <p className="mt-3 text-sm font-semibold">{header}</p>}<p className="mt-2 whitespace-pre-wrap break-words text-sm">{body}</p>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={Boolean(error)} onClick={onApply} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Apply generated copy</button><button type="button" onClick={onRegenerate} className="rounded-lg border bg-card px-3 py-2 text-sm">Regenerate</button><button type="button" onClick={onDiscard} className="rounded-lg px-3 py-2 text-sm">Discard suggestion</button></div></div>;
}
