"use client";

import { useState, type KeyboardEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Comparison } from "@/lib/comparison-content";
import { featureGroups } from "@/lib/comparison-matrix";
import { BRAND_NAME } from "@/lib/brand";

type View = "table" | "summary";

export default function ComparisonMatrix({ comparison }: { comparison: Comparison }) {
  const [view, setView] = useState<View>("table");
  const changeViewWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextView: View = event.key === "ArrowLeft" || event.key === "Home" ? "table" : "summary";
    setView(nextView);
    document.getElementById(nextView === "table" ? "feature-table-tab" : "summary-tab")?.focus();
  };

  return (
    <section id="features" className="scroll-mt-20 border-y border-border bg-card py-16 sm:py-20">
      <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
        <div className="flex flex-col gap-7 border-b border-border pb-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Feature comparison</p>
            <h2 className="mt-3 max-w-3xl text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Follow the work from first lead to final result.</h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">Compare documented workflows across discovery, creative, outreach, paid media and operational review.</p>
          </div>
          <div role="tablist" aria-label="Comparison view" className="inline-flex w-fit rounded-lg border border-border bg-background p-1">
            <button id="feature-table-tab" role="tab" type="button" tabIndex={view === "table" ? 0 : -1} aria-selected={view === "table"} aria-controls="feature-table-panel" onKeyDown={changeViewWithKeyboard} onClick={() => setView("table")} className={`min-h-10 rounded-md px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === "table" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}>Feature table</button>
            <button id="summary-tab" role="tab" type="button" tabIndex={view === "summary" ? 0 : -1} aria-selected={view === "summary"} aria-controls="summary-panel" onKeyDown={changeViewWithKeyboard} onClick={() => setView("summary")} className={`min-h-10 rounded-md px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === "summary" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}>Decision summary</button>
          </div>
        </div>

        <div id="feature-table-panel" role="tabpanel" aria-labelledby="feature-table-tab" hidden={view !== "table"}>
          <div className="border-x border-b border-border">
            <table className="block w-full border-collapse md:table">
              <caption className="sr-only">{BRAND_NAME} and {comparison.name} feature comparison</caption>
              <thead className="hidden md:table-header-group">
                <tr>
                  <th scope="col" className="sticky top-16 z-10 w-[24%] border-b border-border bg-[#0f172a] px-5 py-5 text-left text-xs font-semibold text-white">Capability</th>
                  <th scope="col" className="sticky top-16 z-10 w-[38%] border-b border-l border-white/15 bg-[#0f172a] px-5 py-5 text-left text-xs font-semibold text-white">{BRAND_NAME}</th>
                  <th scope="col" className="sticky top-16 z-10 w-[38%] border-b border-l border-white/15 bg-[#0f172a] px-5 py-5 text-left text-xs font-semibold text-white">{comparison.name}</th>
                </tr>
              </thead>
              {featureGroups.map((group) => (
                <tbody key={group.id} className="block md:table-row-group">
                  <tr className="block md:table-row">
                    <th scope="rowgroup" colSpan={3} className="block border-y border-border bg-muted/45 px-5 py-4 text-left md:table-cell">
                      <span className="text-sm font-semibold">{group.title}</span><span className="ml-3 hidden text-xs font-normal text-muted-foreground sm:inline">{group.description}</span>
                    </th>
                  </tr>
                  {group.rows.map((row) => {
                    const competitorValue = row.competitor[comparison.slug];
                    return (
                      <tr key={row.label} className="block border-b border-border last:border-b-0 md:table-row">
                        <th scope="row" className="block px-5 pb-1 pt-5 text-left text-sm font-semibold md:table-cell md:border-b md:border-border md:px-5 md:py-5 md:align-top">{row.label}</th>
                        <td className="block px-5 py-2 text-sm leading-6 md:table-cell md:border-b md:border-l md:border-border md:bg-primary/[0.035] md:px-5 md:py-5 md:align-top"><span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.1em] text-primary md:hidden">{BRAND_NAME}</span>{row.askSales}</td>
                        <td className="block px-5 pb-5 pt-2 text-sm leading-6 text-muted-foreground md:table-cell md:border-b md:border-l md:border-border md:px-5 md:py-5 md:align-top"><span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.1em] text-foreground md:hidden">{comparison.name}</span>{competitorValue ?? <span className="italic">Not established in the reviewed sources</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
          <p className="mt-5 max-w-4xl text-xs leading-6 text-muted-foreground">“Not established” means the linked vendor pages did not describe a directly comparable workflow. It does not mean the product cannot do it. Channel access and provider actions can depend on your plan, connected account and permissions.</p>
        </div>

        <div id="summary-panel" role="tabpanel" aria-labelledby="summary-tab" hidden={view !== "summary"} className="py-3">
          <div className="border-b border-border">
            {comparison.rows.map(({ capability, askSales, competitor }) => (
              <article key={capability} className="grid gap-4 border-b border-border py-6 last:border-b-0 md:grid-cols-[minmax(9rem,.55fr)_1fr_1fr] md:gap-8">
                <h3 className="text-sm font-semibold">{capability}</h3>
                <p className="text-sm leading-6"><span className="mb-1 block text-[11px] font-semibold text-primary md:hidden">{BRAND_NAME}</span>{askSales}</p>
                <p className="text-sm leading-6 text-muted-foreground"><span className="mb-1 block text-[11px] font-semibold md:hidden">{comparison.name}</span>{competitor}</p>
              </article>
            ))}
          </div>
          <a href="#sources" className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Review source pages <ArrowUpRight className="h-4 w-4" /></a>
        </div>
      </div>
    </section>
  );
}
