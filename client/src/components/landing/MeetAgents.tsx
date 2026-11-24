import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { agentsData } from "@/lib/agents-data";

export default function MeetAgents() {
  return (
    <section className="border-b border-border bg-background py-20 sm:py-24">
      <div className="mx-auto max-w-[1320px] px-5 sm:px-10">
        <div className="grid gap-12 lg:grid-cols-[0.68fr_1.32fr] lg:gap-20">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-primary">Specialist roles</p>
            <h2 className="mt-4 max-w-md text-2xl font-semibold tracking-tight sm:text-3xl">A coordinated team inside one campaign.</h2>
            <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">
              Bring in the specialist needed for the next step without losing the campaign’s thread, resources, or approval state.
            </p>
            <Link href="/agents" className="mt-7 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
              View every specialist <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {agentsData.slice(0, 5).map((agent, index) => (
              <Link
                key={agent.slug}
                href={`/agents/${agent.slug}`}
                className="group grid gap-3 border-b border-border px-5 py-5 transition-colors last:border-b-0 hover:bg-muted/35 sm:grid-cols-[2.5rem_9rem_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background">
                  <agent.icon className="h-4 w-4 text-primary" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{agent.role}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Specialist</p>
                </div>
                <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{agent.description}</p>
                <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  0{index + 1} <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
