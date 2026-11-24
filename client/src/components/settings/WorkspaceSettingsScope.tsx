"use client";

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { businessProfileName, useBusinessProfiles } from '@/hooks/use-business-profiles';
import { WORKSPACE_SETTINGS_HREF } from '@/lib/settings-navigation';
import { cn } from '@/lib/utils';

export function WorkspaceSettingsScope({ detail, showOverviewLink = true, className }: { detail: string; showOverviewLink?: boolean; className?: string }) {
  const profiles = useBusinessProfiles();
  return <section aria-label="Setting scope" className={cn("flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-xl border bg-muted/20 p-4", className)}>
    <div className="min-w-0 flex-1 text-sm">
      {profiles.isError ? <div role="alert"><p>Workspace could not be verified.</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void profiles.refetch()}>Retry workspace</Button></div>
        : profiles.isLoading ? <p role="status">Checking selected workspace…</p>
        : profiles.activeProfile ? <><p className="break-words font-medium">Workspace: {businessProfileName(profiles.activeProfile)}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></>
        : <p>No workspace selected. <Link href="/dashboard/select-profile" className="text-primary underline">Choose a workspace</Link></p>}
    </div>
    {showOverviewLink && <Link href={WORKSPACE_SETTINGS_HREF} className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4">Workspace configuration</Link>}
  </section>;
}
