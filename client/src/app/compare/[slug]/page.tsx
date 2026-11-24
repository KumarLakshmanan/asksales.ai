import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import ComparisonMatrix from "@/components/compare/ComparisonMatrix";
import { BRAND_NAME } from "@/lib/brand";
import { comparisons, getComparison } from "@/lib/comparison-content";

type PageProps = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return comparisons.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const comparison = getComparison(slug);
  if (!comparison) return { title: "Comparison not found" };
  return {
    title: { absolute: `${BRAND_NAME} vs ${comparison.name}` },
    description: comparison.summary,
    alternates: { canonical: `/compare/${comparison.slug}` },
  };
}

const campaignStages = [
  ["01", "Audience", "Research and store a lead resource"],
  ["02", "Assets", "Prepare copy and creative"],
  ["03", "Review", "Check recipients, channels and spend"],
  ["04", "Result", "Reconcile the provider response"],
] as const;

export default async function ComparisonPage({ params }: PageProps) {
  const { slug } = await params;
  const comparison = getComparison(slug);
  if (!comparison) notFound();
  const otherComparisons = comparisons.filter((item) => item.slug !== comparison.slug);

  return (
    <PublicLayout>
      <section className="border-b border-border bg-background pt-28 sm:pt-32">
        <div className="mx-auto max-w-[1440px] px-5 pb-16 sm:px-8 sm:pb-20 lg:px-12">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link href="/compare" className="hover:text-primary">Comparisons</Link>
            <span aria-hidden="true">/</span>
            <span className="text-foreground">{comparison.name}</span>
          </nav>
          <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(22rem,.9fr)] lg:gap-20">
            <div className="flex flex-col justify-center">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">{comparison.shortFocus}</p>
              <h1 className="mt-5 max-w-3xl text-balance text-[clamp(2.7rem,5vw,4.8rem)] font-semibold leading-[1.02] tracking-[-0.05em]">{BRAND_NAME} vs {comparison.name}.</h1>
              <p className="mt-6 max-w-2xl text-2xl font-medium leading-8 tracking-tight sm:text-[1.75rem] sm:leading-9">{comparison.headline}</p>
              <p className="mt-5 max-w-2xl text-base leading-8 text-muted-foreground">{comparison.summary}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#features" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">See feature table <ArrowRight className="h-4 w-4" /></a>
                <Link href="/contact" className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Discuss your workflow</Link>
              </div>
            </div>
            <aside className="self-start overflow-hidden rounded-xl border border-border bg-card" aria-label="AskSales campaign workflow">
              <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-5">
                <div><p className="text-sm font-semibold">One request. A traceable result.</p><p className="mt-1 text-xs text-muted-foreground">How an AskSales campaign is organized</p></div>
                <span className="font-mono text-[11px] text-primary">ASKSALES</span>
              </div>
              <ol className="relative mx-6 my-2 border-l border-border">
                {campaignStages.map(([number, title, detail]) => (
                  <li key={number} className="relative grid grid-cols-[2.5rem_1fr] gap-3 border-b border-border py-5 pl-5 last:border-b-0">
                    <span className="absolute -left-[5px] top-7 h-[9px] w-[9px] rounded-full border-2 border-primary bg-card" aria-hidden="true" />
                    <span className="font-mono text-xs text-primary">{number}</span>
                    <div><p className="text-sm font-semibold">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div>
                  </li>
                ))}
              </ol>
              <div className="border-t border-border bg-muted/30 px-6 py-3 text-xs leading-5 text-muted-foreground">Illustrative workflow · actual availability depends on connected providers and review state.</div>
            </aside>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-card">
        <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
          <div className="grid border-x border-border md:grid-cols-2">
            <div className="border-b border-border px-6 py-8 md:border-b-0 md:border-r md:px-8"><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">Choose {BRAND_NAME} when</p><p className="mt-3 max-w-xl text-base leading-7">{comparison.askSalesFit}</p></div>
            <div className="px-6 py-8 md:px-8"><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Choose {comparison.name} when</p><p className="mt-3 max-w-xl text-base leading-7">{comparison.competitorFit}</p></div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-16 sm:px-8 sm:py-20 lg:px-12">
        <div className="grid gap-9 lg:grid-cols-[.7fr_1.3fr] lg:gap-16">
          <div><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">The decision</p><h2 className="mt-4 max-w-sm text-3xl font-semibold tracking-[-0.035em]">Where the products diverge.</h2><p className="mt-5 max-w-sm text-sm leading-7 text-muted-foreground">{comparison.decision}</p></div>
          <div className="border-y border-border">
            {comparison.differences.map(({ title, description }, index) => (
              <article key={title} className="grid gap-3 border-b border-border py-6 last:border-b-0 sm:grid-cols-[2rem_minmax(10rem,.6fr)_1fr] sm:gap-6"><span className="font-mono text-xs text-primary">0{index + 1}</span><h3 className="text-base font-semibold">{title}</h3><p className="text-sm leading-7 text-muted-foreground">{description}</p></article>
            ))}
          </div>
        </div>
      </section>

      <ComparisonMatrix comparison={comparison} />

      <section className="border-b border-border bg-background">
        <div className="mx-auto grid max-w-[1440px] gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[.7fr_1.3fr] lg:gap-16 lg:px-12">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Cost and transition</p>
            <h2 className="mt-4 max-w-sm text-3xl font-semibold tracking-[-0.035em]">Compare the work you actually run.</h2>
            <p className="mt-5 max-w-sm text-sm leading-7 text-muted-foreground">List your monthly volume and connected channels before comparing plans. Include message fees, AI usage, additional seats and ad spend where they apply.</p>
          </div>
          <div className="divide-y divide-border border-y border-border">
            <div className="py-6">
              <h3 className="text-base font-semibold">Check both pricing models</h3>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">{BRAND_NAME} plans include a monthly credit deposit for one account. Published plan prices are separate from the live credit cost of each operation; paid media spend goes to the connected provider. {comparison.name} uses the model described in its current plan page.</p>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                <Link href="/pricing#plan-finder" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Find an AskSales plan <ArrowUpRight className="h-4 w-4" /></Link>
                <a href={comparison.pricingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">View {comparison.name} pricing <ArrowUpRight className="h-4 w-4" /></a>
              </div>
            </div>
            <div className="py-6">
              <h3 className="text-base font-semibold">Plan a small pilot before moving</h3>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">{comparison.transitionFocus} Keep the existing journey running while you test one lead set, one asset and one approved action in AskSales.</p>
              <Link href="/contact" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Discuss the pilot <ArrowUpRight className="h-4 w-4" /></Link>
            </div>
          </div>
        </div>
      </section>

      <section id="questions" className="mx-auto grid w-full max-w-[1440px] scroll-mt-20 gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[.7fr_1.3fr] lg:gap-16 lg:px-12">
        <div><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Questions</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em]">The practical details.</h2><p className="mt-4 max-w-sm text-sm leading-7 text-muted-foreground">Have a specific migration or channel requirement? <Link href="/contact" className="font-medium text-primary hover:underline">Tell us about it</Link>.</p></div>
        <div className="border-y border-border">
          {comparison.faqs.map(({ question, answer }) => <details key={question} className="border-b border-border py-5 last:border-b-0"><summary className="cursor-pointer pr-4 text-base font-semibold marker:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{question}</summary><p className="mt-4 max-w-2xl pr-4 text-sm leading-7 text-muted-foreground">{answer}</p></details>)}
        </div>
      </section>

      <section id="sources" className="scroll-mt-20 border-y border-border bg-muted/20">
        <div className="mx-auto grid max-w-[1440px] gap-7 px-5 py-11 sm:px-8 lg:grid-cols-[.7fr_1.3fr] lg:gap-16 lg:px-12">
          <div><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Source notes</p><h2 className="mt-3 text-xl font-semibold">Check the current product pages.</h2></div>
          <div><p className="max-w-2xl text-sm leading-7 text-muted-foreground">AskSales entries reflect the current workspace and public agent directory. Competitor entries summarize the linked official pages, reviewed September 2026. Plan limits and channel permissions can change.</p><ul className="mt-5 flex flex-wrap gap-x-7 gap-y-3"><li><Link href="/agents" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">AskSales agents <ArrowUpRight className="h-4 w-4" /></Link></li>{comparison.sources.map(({ label, url }) => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">{label} <ArrowUpRight className="h-4 w-4" /></a></li>)}</ul></div>
        </div>
      </section>

      <section className="bg-card">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-5 py-14 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-12"><div><p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Run a real comparison</p><h2 className="mt-3 text-2xl font-semibold tracking-tight">Bring one campaign into the workspace.</h2><p className="mt-2 text-sm text-muted-foreground">Prepare the lead set and assets, review the exact action and read the provider result.</p></div><Link href="/login?mode=register" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Create workspace <ArrowRight className="h-4 w-4" /></Link></div>
      </section>

      <nav aria-label="Other comparisons" className="mx-auto w-full max-w-[1440px] border-t border-border px-5 py-9 sm:px-8 lg:px-12"><p className="text-sm font-semibold">Compare with another platform</p><div className="mt-4 flex flex-wrap gap-2">{otherComparisons.map(({ name, slug: otherSlug }) => <Link key={otherSlug} href={`/compare/${otherSlug}`} className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">vs {name}</Link>)}</div></nav>
    </PublicLayout>
  );
}
