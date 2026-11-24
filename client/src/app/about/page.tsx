import Link from "next/link";
import { ArrowRight } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { BRAND_NAME, COMPANY_NAME } from "@/lib/brand";

const principles = [
  ["State before spectacle", "A result should be inspectable: which resource was stored, which revision was approved, and which provider confirmed the action."],
  ["People keep authority", "The system can prepare and coordinate work. Recipients, spend, destinations, and live activation remain visible at approval time."],
  ["Handoffs preserve context", "Lead IDs, asset IDs, campaign IDs, and provider receipts move between specialists without being reconstructed from chat prose."],
] as const;

export default function AboutPage() {
  return (
    <PublicLayout>
      <section className="border-b border-border pb-16 pt-32 sm:pb-24 sm:pt-36">
        <div className="mx-auto grid max-w-[1440px] gap-12 px-5 sm:px-8 lg:grid-cols-[1.15fr_.85fr] lg:px-12">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary">About {BRAND_NAME}</p>
            <h1 className="mt-5 max-w-4xl text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] sm:text-5xl">Sales and marketing automation should remain accountable.</h1>
          </div>
          <div className="self-end border-l border-border pl-6">
            <p className="text-lg leading-8 text-muted-foreground">{BRAND_NAME}, a product of {COMPANY_NAME}, is designed as a shared operating surface for lead research, content, outreach, and paid campaign work—not a collection of disconnected chat tricks.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[.7fr_1.3fr] lg:px-12 lg:py-24">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Working model</p>
          <p className="mt-4 max-w-sm text-2xl font-medium leading-9">One request can involve several specialists. The workflow—not a message bubble—owns completion.</p>
        </div>
        <div className="border-y border-border">
          {["Understand the request and required resources", "Prepare durable drafts with exact identifiers", "Present a review when authority is required", "Execute through the selected provider", "Reconcile receipts and partial failures"].map((item, index) => (
            <div key={item} className="grid grid-cols-[42px_1fr] border-b border-border py-5 last:border-b-0"><span className="font-mono text-xs text-muted-foreground">0{index + 1}</span><p>{item}</p></div>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-muted/20">
        <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
          {principles.map(([title, copy], index) => (
            <article key={title} className="grid gap-4 border-b border-border py-9 last:border-b-0 sm:grid-cols-[80px_260px_1fr] sm:gap-8">
              <span className="font-mono text-xs text-muted-foreground">P-{index + 1}</span><h2 className="text-xl font-semibold">{title}</h2><p className="max-w-2xl leading-7 text-muted-foreground">{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-16 sm:flex-row sm:items-end sm:justify-between sm:px-8 lg:px-12 lg:py-20">
        <div><p className="font-mono text-xs uppercase tracking-[0.14em] text-primary">Start with a real workflow</p><h2 className="mt-4 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">Create a workspace and keep the work visible from brief to provider result.</h2></div>
        <Link href="/login?mode=register" className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground">Create workspace<ArrowRight className="h-4 w-4" /></Link>
      </section>
    </PublicLayout>
  );
}
