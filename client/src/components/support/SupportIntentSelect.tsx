"use client";
import { useState } from "react";
import { SUPPORT_INTENTS } from "../../../../shared/supportIntents";

export function SupportIntentSelect({ value, onChange, disabled, allowAll = true }: { value: string; onChange: (value: string) => void; disabled?: boolean; allowAll?: boolean }) {
  const [search, setSearch] = useState("");
  const options = SUPPORT_INTENTS.filter((intent) => intent === value || intent.replaceAll("_", " ").includes(search.toLowerCase().trim()));
  return <div className="space-y-1"><input type="search" aria-label="Find request type" placeholder="Find a request type…" value={search} onChange={(event) => setSearch(event.target.value)} disabled={disabled} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" /><select aria-label="Customer request type" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{allowAll ? <option value="">All customer requests</option> : <option value="" disabled>Choose a request type</option>}{options.map((intent) => <option key={intent} value={intent}>{intent.replaceAll("_", " ")}</option>)}</select>{!options.length && <p className="text-xs text-muted-foreground">No matching request types.</p>}</div>;
}
