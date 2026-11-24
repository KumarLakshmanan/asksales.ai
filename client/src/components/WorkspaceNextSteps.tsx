"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ChevronDown, Circle, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { useAuth } from "@/contexts/AuthContext";
import { usePlatformAccess } from "@/hooks/use-platform-access";
import type { BusinessProfileSummary } from "@/hooks/use-business-profiles";
import { workspaceNextSteps, type OnboardingStatus } from "@/lib/workspace-next-steps";
import { trackSetupEvent } from "@/lib/setup-analytics";
import { Button } from "@/components/ui/button";

export function WorkspaceNextSteps({ profile }: { profile: BusinessProfileSummary }) {
  const { user } = useAuth();
  const access = usePlatformAccess();
  const status = useQuery({
    queryKey: ["workspace-onboarding-status", user?.id, profile.id],
    queryFn: () => api.get<OnboardingStatus>("/api/setup/onboarding-status", { headers: { [BUSINESS_PROFILE_HEADER]: String(profile.id) } }),
    enabled: Boolean(user), staleTime: 30_000,
  });
  if (status.isLoading) return <p className="text-sm text-muted-foreground" role="status">Finding your next steps…</p>;
  if (status.isError || !status.data) return <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"><p className="text-sm text-muted-foreground" role="status">Your next steps could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void status.refetch()}>Try again</Button></div>;
  const enabled = access.data?.modules.filter(module => module.enabled).map(module => module.key) ?? [];
  const tasks = workspaceNextSteps(status.data, profile.role, enabled);
  if (!tasks.length) return null;
  const completed = tasks.filter(task => task.completed).length;
  const checklist = <>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
      <div><h2 id="workspace-next-steps-title" className="text-base font-semibold">Put your workspace to work</h2><p className="mt-1 text-sm text-muted-foreground">{completed} of {tasks.length} steps complete. Channel selections are preferences; completion uses saved workspace activity and confirmed connections.</p>{status.data.profile.setupGoal && <p className="mt-2 text-sm"><span className="font-medium">Your first goal:</span> {status.data.profile.setupGoal}</p>}</div>
      <Button variant="ghost" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()} aria-label="Refresh workspace next steps"><RefreshCw className={`h-4 w-4 ${status.isFetching ? "animate-spin" : ""}`} /></Button>
    </div>
    <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0">{tasks.map(task => <li key={task.id} className="min-w-0"><Link href={task.href} onClick={() => trackSetupEvent("first_action_opened", { action: task.id })} className="flex h-full items-start gap-3 rounded-xl p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">{task.completed ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />}<span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{task.title}<span className="sr-only">{task.completed ? " — Complete" : " — Next step"}</span></span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{task.description}</span></span><ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /></Link></li>)}</ul>
  </>;
  if (completed === tasks.length) {
    return <section aria-label="Workspace setup" className="rounded-xl border border-border bg-card">
      <details className="group/setup">
        <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span className="flex-1 font-medium">Workspace setup complete</span>
          <span className="text-xs text-muted-foreground">Review setup</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/setup:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-border">{checklist}</div>
      </details>
    </section>;
  }
  return <section aria-labelledby="workspace-next-steps-title" className="rounded-2xl border border-border bg-card">{checklist}</section>;
}
