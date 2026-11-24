"use client";

import { ArrowRight, BarChart3, CheckCircle2, CircleHelp, MousePointerClick } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuideChecklist, GuideFigure } from "./ConnectionGuide";

export function MetaAdsConnectionGuide({ onConnect, connecting = false }: { onConnect: () => void; connecting?: boolean }) {
  return <section id="connection-guide" aria-labelledby="meta-ads-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-gradient-to-r from-blue-500/10 to-violet-500/5 p-6 sm:p-8 lg:p-10"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300"><BarChart3 className="h-4 w-4" /> Meta Ads guide</span><h2 id="meta-ads-guide-title" className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Connect your ad account</h2><p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">Authorize Meta Ads separately from Facebook Page messaging. Then choose the ad account and Page AskSales should use.</p><Button className="mt-6 rounded-full bg-blue-600 text-white hover:bg-blue-700" onClick={onConnect} disabled={connecting}>{connecting ? "Opening Meta…" : "Connect Meta Ads"}<ArrowRight className="ml-2 h-4 w-4" /></Button></div>
    <div className="p-6 sm:p-8 lg:p-10"><GuideChecklist items={["Use the Facebook account with access to the ad account you want to connect.", "Know which Facebook Page should be paired with the ad account.", "Review the advertising permissions requested by Meta."]} />
      <div className="mt-9 grid gap-8 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
        <ol className="space-y-5">
          <li className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-xs font-bold text-blue-700">1</span><div><h3 className="text-sm font-semibold">Continue with Meta</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Sign in with the Facebook account that manages your advertising assets and approve the requested access.</p></div></li>
          <li className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-xs font-bold text-blue-700">2</span><div><h3 className="text-sm font-semibold">Choose ad account and Page</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">After authorization, select the authorized ad account and Facebook Page in AskSales if prompted.</p></div></li>
          <li className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-xs font-bold text-blue-700">3</span><div><h3 className="text-sm font-semibold">Check readiness</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Confirm the ad account, Page, and granted capabilities before managing campaigns.</p></div></li>
        </ol>
        <GuideFigure image="meta-ads-selection-single" alt="Meta Ads account and Page selection example" />
      </div>
    </div>
  </section>;
}

export function GoogleAdsConnectionGuide({ onConnect, connecting = false, unavailableReason }: { onConnect: () => void; connecting?: boolean; unavailableReason?: string }) {
  return <section id="connection-guide" aria-labelledby="google-ads-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-gradient-to-r from-blue-500/5 via-card to-amber-500/5 p-6 sm:p-8 lg:p-10"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-700 dark:text-indigo-300"><MousePointerClick className="h-4 w-4" /> Google Ads guide</span><h2 id="google-ads-guide-title" className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Connect Google Ads</h2><p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">Authorize a Google account with Ads access, then choose an authorized customer account in AskSales.</p><Button className="mt-6 rounded-full" onClick={onConnect} disabled={connecting || Boolean(unavailableReason)} aria-describedby={unavailableReason ? "google-ads-guide-unavailable" : undefined}>{connecting ? "Opening Google…" : "Connect Google Ads"}<ArrowRight className="ml-2 h-4 w-4" /></Button>{unavailableReason && <p id="google-ads-guide-unavailable" className="mt-3 text-sm text-muted-foreground">{unavailableReason}</p>}</div>
    <div className="p-6 sm:p-8 lg:p-10"><GuideChecklist items={["Use a Google account with access to the intended Google Ads customer account.", "Approve Google Ads access when Google asks for permission.", "Choose the customer account you want AskSales to use after sign-in."]} />
      <div className="mt-9 grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
        <article className="rounded-2xl border p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-indigo-600">Step 01 · Google sign-in</span><h3 className="mt-2 text-lg font-semibold">Choose the account</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Select the Google account with access to the Ads customer account and approve the requested access.</p><GuideFigure image="google-ads-account-single" alt="Google Ads account chooser example" className="mt-4" /></article>
        <article className="rounded-2xl border p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-indigo-600">Step 02 · AskSales account</span><h3 className="mt-2 text-lg font-semibold">Choose a customer account</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">After Google returns you here, select an account from the authorized list. AskSales handles the developer credentials.</p><GuideFigure image="google-ads-details-single" alt="Google Ads account selection example" className="mt-4" /></article>
      </div>
      <div className="mt-5 flex gap-3 rounded-2xl border bg-indigo-500/5 p-5"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" /><p className="text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Step 03 · Verify readiness.</strong> Check the connected customer account and readiness status before opening campaigns.</p></div>
      <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" /> If no account appears after sign-in, check that your Google user has access to a Google Ads customer account.</p>
    </div>
  </section>;
}
