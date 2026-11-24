"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { Button } from "@/components/ui/button";
import { agentsData, getAgentBySlug } from "@/lib/agents-data";
import { useAuth } from "@/contexts/AuthContext";

export default function AgentDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const agent = getAgentBySlug(slug);

  if (!agent) {
    return <PublicLayout><section className="mx-auto w-full max-w-[1440px] px-5 pb-24 pt-36 sm:px-8 lg:px-12"><p className="font-mono text-xs text-muted-foreground">404 / AGENT</p><h1 className="mt-5 text-3xl font-semibold">Agent not found</h1><Link href="/agents" className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-primary"><ArrowLeft className="h-4 w-4" />Return to directory</Link></section></PublicLayout>;
  }

  const otherAgents = agentsData.filter((item) => item.slug !== slug);

  return (
    <PublicLayout>
      <section className="border-b border-border pb-16 pt-28 sm:pb-20 sm:pt-32">
        <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
          <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Agent directory</Link>
          <div className="mt-10 grid gap-10 lg:grid-cols-[1.1fr_.9fr]">
            <div>
              <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted/50 text-primary"><agent.icon className="h-6 w-6" /></div>
              <p className="mt-7 font-mono text-xs uppercase tracking-[0.18em] text-primary">AI specialist</p>
              <h1 className="mt-4 max-w-2xl text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] sm:text-5xl">{agent.role}</h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">{agent.description}</p>
              <Button onClick={() => router.push(isAuthenticated ? `/dashboard/conversations?agent=${agent.chatKey}` : "/login?mode=register")} className="mt-8 gap-2">Open in workspace<ArrowRight className="h-4 w-4" /></Button>
            </div>
            <div className="self-end border-y border-border">
              {agent.features.map((feature, index) => <div key={feature} className="grid grid-cols-[40px_1fr] border-b border-border py-4 last:border-b-0"><span className="font-mono text-xs text-muted-foreground">0{index + 1}</span><span>{feature}</span></div>)}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[.65fr_1.35fr] lg:px-12 lg:py-24">
        <div><p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Capabilities</p><h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">What this specialist can prepare.</h2><p className="mt-4 leading-7 text-muted-foreground">Execution still depends on configured providers, prerequisites, and approval state.</p></div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          {agent.capabilities.map((capability, index) => <div key={capability} className="bg-background p-6"><span className="font-mono text-xs text-primary">C-{index + 1}</span><p className="mt-4 leading-7 text-muted-foreground">{capability}</p></div>)}
        </div>
      </section>

      <section className="border-y border-border bg-muted/20">
        <div className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8 lg:px-12">
          <h2 className="text-2xl font-semibold">Execution contract</h2>
          <div className="mt-7 grid gap-5 sm:grid-cols-3">
            {["Resources are stored before result tabs open.", "Approval shows identifiers and spend-affecting fields.", "Terminal language follows persisted state or provider receipts."].map((item) => <p key={item} className="flex gap-3 text-sm leading-6 text-muted-foreground"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{item}</p>)}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-16 sm:px-8 lg:px-12"><div className="flex items-end justify-between"><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Related specialists</p><h2 className="mt-3 text-2xl font-semibold">Continue the campaign</h2></div><Link href="/agents" className="text-sm text-primary">View all</Link></div><div className="mt-7 border-y border-border">{otherAgents.map((item) => <Link key={item.slug} href={`/agents/${item.slug}`} className="group flex items-center justify-between border-b border-border py-5 last:border-b-0"><span>{item.role}</span><ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1" /></Link>)}</div></section>
    </PublicLayout>
  );
}
