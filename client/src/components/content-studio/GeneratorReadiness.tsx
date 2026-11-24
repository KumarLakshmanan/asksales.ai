"use client";

import Link from "next/link";
import { useContentBrandContext } from "@/hooks/use-content-brand-context";

export function GeneratorReadiness() {
  const context = useContentBrandContext();
  return <aside className="mx-4 mt-4 rounded-lg border border-border bg-muted/20 p-3 text-xs" aria-label="Generation setup and saving">
    <details open={Boolean(context.missingMessage)}>
    <summary className="cursor-pointer font-medium">{context.isLoading ? "Checking generation setup…" : context.isError ? "Setup check unavailable" : context.isReady ? "Brand context ready" : "Complete generation setup"}</summary>
    {context.missingMessage && <p className="mt-2 text-amber-700 dark:text-amber-400">{context.missingMessage}</p>}
    <ul className="mt-3 space-y-2 text-muted-foreground">
      <li>Business profile: {context.businessProfile ? "Selected" : "Required"} · <Link href="/dashboard/home?workspace=choose" className="underline">Manage</Link></li>
      <li>Brand Toolkit: {context.toolkit ? "Selected" : "Required"} · <Link href="/dashboard/brand-toolkit" className="underline">Manage</Link></li>
      <li>Website: {context.businessProfile?.website || context.toolkit?.website || "Not set — needed for destination links"}</li>
      <li>Sending and publishing require a connected account. These are checked in the destination workflow; generating a draft does not send it.</li>
    </ul>
    {context.isError && <button type="button" onClick={() => void context.refetch()} className="mt-2 underline">Retry setup check</button>}
    </details>
    <p className="mt-3 border-t border-border pt-2 text-muted-foreground">AI generation saves a draft to Recent and your library. Review it before publishing or using it in outreach. Prompts recover in this browser tab.</p>
  </aside>;
}
