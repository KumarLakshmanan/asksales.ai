import { CheckSquare, FileCheck2, ReceiptText, Route } from "lucide-react";

const controls = [
  {
    icon: Route,
    title: "One coordinated run",
    description: "The orchestrator keeps prerequisites, handoffs, approvals, and provider work attached to the same campaign run.",
  },
  {
    icon: CheckSquare,
    title: "Review the exact action",
    description: "See lead IDs, message copy, creative revision, destinations, schedule, and spend before authorizing execution.",
  },
  {
    icon: FileCheck2,
    title: "Resources before result tabs",
    description: "Leads, content, campaigns, and selections open in the workspace only after their durable record exists.",
  },
  {
    icon: ReceiptText,
    title: "Provider-backed language",
    description: "Queued is not sent. Created is not active. Every terminal claim is tied to the state the provider actually returned.",
  },
];

export default function Features() {
  return (
    <section className="border-b border-border bg-card py-20 sm:py-24">
      <div className="mx-auto max-w-[1320px] px-5 sm:px-10">
        <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-primary">Built for accountable execution</p>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Automation you can inspect.</h2>
            <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">
              The workspace is designed around decisions and receipts—not black-box activity or optimistic success messages.
            </p>
          </div>
          <div className="border-y border-border">
            {controls.map(({ icon: Icon, title, description }, index) => (
              <article key={title} className="grid gap-4 border-b border-border py-6 last:border-b-0 sm:grid-cols-[3rem_12rem_minmax(0,1fr)] sm:items-start">
                <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="h-4 w-4 text-primary" /> {title}
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{description}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
