import Link from "next/link";
import { ArrowRight, Check, CircleDot, Clock3, Database, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";

const executionSteps = [
  { icon: Check, label: "Campaign brief", detail: "Audience and outcome confirmed", state: "Ready" },
  { icon: Database, label: "Lead resource", detail: "Stored with exact lead IDs", state: "Durable" },
  { icon: ShieldCheck, label: "Outreach action", detail: "Recipient list and message review", state: "Needs review" },
  { icon: Clock3, label: "Provider delivery", detail: "Receipt required before success", state: "Not started" },
];

export default function Hero() {
  return (
    <section className="border-b border-border bg-background pt-24 sm:pt-28">
      <div className="mx-auto grid min-h-[36rem] max-w-[1440px] lg:grid-cols-[minmax(0,1fr)_minmax(28rem,0.8fr)]">
        <div className="flex flex-col justify-center px-5 py-14 sm:px-10 lg:border-r lg:border-border lg:px-16 xl:px-20">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-primary">Revenue operations workspace</p>
          <h1 className="mt-5 max-w-3xl text-[clamp(2.65rem,5.5vw,4.75rem)] font-semibold leading-[0.98] tracking-[-0.045em]">
            Ask for the outcome. Review the work.
          </h1>
          <p className="mt-7 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            {BRAND_NAME} coordinates lead research, outreach, content, and paid campaigns in one conversation—while keeping approvals, durable resources, and provider results visible.
          </p>
          <div className="mt-9 flex items-center gap-4">
            <Button asChild size="lg" className="h-11 gap-2 px-5">
              <Link href="/login?mode=register">Create a workspace <ArrowRight className="h-4 w-4" /></Link>
            </Button>
            <span className="hidden text-sm text-muted-foreground sm:inline">Review before anything runs.</span>
          </div>
        </div>

        <div className="flex items-center bg-card px-5 py-14 sm:px-10 lg:px-12">
          <div className="w-full overflow-hidden rounded-xl border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <p className="text-sm font-semibold">Campaign execution</p>
                <p className="mt-0.5 text-xs text-muted-foreground">One request, four accountable states</p>
              </div>
              {/* Dark mode's --warning-foreground is near-black (made for text on a solid warning fill),
                  so on this 10% tint it vanished. Use the bright warning colour there instead. */}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning-foreground dark:text-warning">
                <CircleDot className="h-3 w-3" aria-hidden="true" /> Awaiting approval
              </span>
            </div>
            <div className="divide-y divide-border">
              {executionSteps.map(({ icon: Icon, label, detail, state }, index) => (
                <div key={label} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-5 py-4">
                  <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/35">
                      <Icon className="h-4 w-4 text-primary" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="truncate text-xs text-muted-foreground">{detail}</p>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">{state}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-border bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
              “Created,” “sent,” and “active” appear only after a durable record or provider receipt exists.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
