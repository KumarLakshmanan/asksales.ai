import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { agentsData } from "@/lib/agents-data";

export default function AgentsPage() {
  return (
    <PublicLayout>
      <section className="border-b border-border pb-16 pt-32 sm:pb-20 sm:pt-36">
        <div className="mx-auto grid max-w-[1440px] gap-10 px-5 sm:px-8 lg:grid-cols-[1.1fr_.9fr] lg:px-12">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary">Agent directory</p>
            <h1 className="mt-5 max-w-3xl text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] sm:text-5xl">Specialists coordinated inside one campaign.</h1>
          </div>
          <p className="self-end text-lg leading-8 text-muted-foreground">Each specialist prepares a scoped resource or action. The orchestrator carries durable IDs, prerequisites, approvals, and provider results across handoffs.</p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
        <div className="border-y border-border">
          {agentsData.map((agent, index) => (
            <Link key={agent.slug} href={`/agents/${agent.slug}`} className="group grid gap-5 border-b border-border py-7 last:border-b-0 sm:grid-cols-[64px_1fr_1.2fr_40px] sm:items-start sm:gap-8">
              <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/50 text-primary"><agent.icon className="h-5 w-5" /></div>
                <h2 className="mt-4 text-xl font-semibold tracking-tight">{agent.role}</h2>
              </div>
              <div>
                <p className="leading-7 text-muted-foreground">{agent.description}</p>
                <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {agent.features.slice(0, 3).map((feature) => <li key={feature} className="before:mr-2 before:text-primary before:content-['—']">{feature}</li>)}
                </ul>
              </div>
              <ArrowUpRight className="hidden h-5 w-5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground sm:block" />
            </Link>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-muted/20">
        <div className="mx-auto grid max-w-[1440px] gap-px bg-border px-5 sm:grid-cols-3 sm:px-8 lg:px-12">
          {[
            ["Scoped", "Every handoff names the resource and action it is allowed to change."],
            ["Reviewable", "Spend, recipients, destinations, and creative revisions remain visible before approval."],
            ["Reconciled", "Queued, provider-created, sent, delivered, and active remain distinct states."],
          ].map(([title, copy]) => <div key={title} className="bg-background px-6 py-8"><h2 className="font-medium">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{copy}</p></div>)}
        </div>
      </section>
    </PublicLayout>
  );
}
