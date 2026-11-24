import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { BRAND_NAME } from "@/lib/brand";
import { comparisons } from "@/lib/comparison-content";
import { featureGroups } from "@/lib/comparison-matrix";

export const metadata: Metadata = {
  title: "Compare platforms",
  description: `Compare ${BRAND_NAME} with ManyChat, Wati, Interakt, Respond.io and AiSensy across the full campaign workflow.`,
  alternates: { canonical: "/compare" },
};

export default function ComparePage() {
  return (
    <PublicLayout>
      <section className="border-b border-border bg-background pt-28 sm:pt-32">
        <div className="mx-auto grid max-w-[1440px] gap-12 px-5 pb-16 sm:px-8 sm:pb-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,.85fr)] lg:gap-20 lg:px-12">
          <div className="flex flex-col justify-center">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">AskSales comparisons</p>
            <h1 className="mt-5 max-w-3xl text-balance text-[clamp(2.7rem,5vw,4.8rem)] font-semibold leading-[1.02] tracking-[-0.05em]">Compare the whole campaign.</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">See how {BRAND_NAME} works alongside five messaging and customer engagement platforms. Start with each product&apos;s strengths, then compare discovery, creative, outreach, ads and operational proof in a full feature table.</p>
            <a href="#compare-products" className="mt-8 inline-flex min-h-11 w-fit items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Choose a comparison <ArrowRight className="h-4 w-4" /></a>
          </div>
          <aside className="self-start overflow-hidden rounded-xl border border-border bg-card" aria-label="What the comparison covers">
            <div className="border-b border-border px-6 py-5"><p className="text-sm font-semibold">What you can compare</p><p className="mt-1 text-xs text-muted-foreground">The same five work areas on every page</p></div>
            <div className="divide-y divide-border px-6">
              {featureGroups.map((group) => <div key={group.id} className="grid grid-cols-[minmax(8rem,.6fr)_1fr] gap-4 py-4"><p className="text-sm font-semibold">{group.title}</p><p className="text-xs leading-5 text-muted-foreground">{group.description}</p></div>)}
            </div>
            <div className="border-t border-border bg-muted/30 px-6 py-3 text-xs text-muted-foreground">Feature cells use verified vendor descriptions and name unknowns clearly.</div>
          </aside>
        </div>
      </section>

      <section id="compare-products" className="mx-auto w-full max-w-[1440px] scroll-mt-20 px-5 py-16 sm:px-8 sm:py-20 lg:px-12">
        <div className="grid gap-6 border-b border-border pb-8 lg:grid-cols-[.7fr_1.3fr] lg:gap-16">
          <div><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Choose a platform</p><h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">Five honest comparisons.</h2></div>
          <p className="max-w-2xl self-end text-sm leading-7 text-muted-foreground">Every page includes a quick decision, where each product fits, a full grouped table, practical FAQs and links to the vendor&apos;s own product documentation.</p>
        </div>
        <div className="border-b border-border">
          {comparisons.map((comparison) => (
            <Link key={comparison.slug} href={`/compare/${comparison.slug}`} className="group grid gap-4 border-b border-border py-7 last:border-b-0 md:grid-cols-[minmax(10rem,.5fr)_minmax(14rem,.8fr)_minmax(0,1fr)_1.5rem] md:items-center md:gap-8">
              <div><span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">vs</span><h3 className="mt-1 text-xl font-semibold tracking-tight group-hover:text-primary">{comparison.name}</h3></div>
              <p className="text-sm font-medium leading-6">{comparison.headline}</p>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">{comparison.shortFocus}. {comparison.askSalesFit}</p>
              <ArrowUpRight className="hidden h-5 w-5 text-muted-foreground transition-colors group-hover:text-primary md:block" aria-hidden="true" />
              <span className="inline-flex items-center gap-1 text-sm font-medium text-primary md:hidden">Read comparison <ArrowRight className="h-4 w-4" /></span>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-5 py-14 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-12"><div><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">See your own workflow</p><h2 className="mt-3 text-2xl font-semibold tracking-tight">Start with one campaign request.</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Build the audience and assets, review the action, then check the provider result.</p></div><Link href="/login?mode=register" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Create workspace <ArrowRight className="h-4 w-4" /></Link></div>
      </section>
    </PublicLayout>
  );
}
