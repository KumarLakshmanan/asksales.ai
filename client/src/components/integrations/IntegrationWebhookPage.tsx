"use client";

import Link from "next/link";
import { ArrowLeft, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WebhookEventsWorkspace } from "@/components/integrations/WebhookEventsWorkspace";

export function IntegrationWebhookPage({ platform, platformLabel, backHref, backLabel }: { platform: string; platformLabel: string; backHref: string; backLabel: string }) {
  return <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
    <header><Button asChild variant="ghost" size="sm" className="-ml-3"><Link href={backHref}><ArrowLeft className="mr-2 h-4 w-4" />{backLabel}</Link></Button><div className="mt-4 flex items-start gap-4"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Bell className="h-6 w-6" /></span><div><p className="text-sm font-medium text-muted-foreground">{platformLabel}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Events and activity</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">See the customer messages, interactions, and delivery updates received from {platformLabel}.</p></div></div></header>
    <WebhookEventsWorkspace platform={platform} platformLabel={platformLabel} />
  </div>;
}
