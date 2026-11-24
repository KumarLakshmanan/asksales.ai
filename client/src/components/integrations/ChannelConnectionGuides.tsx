"use client";

import { ArrowRight, CheckCircle2, Instagram, MessageCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuideChecklist, GuideFigure } from "./ConnectionGuide";

export function InstagramConnectionGuide({ onConnect, connecting = false }: { onConnect: () => void; connecting?: boolean }) {
  return <section id="connection-guide" aria-labelledby="instagram-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-gradient-to-r from-fuchsia-500/10 via-rose-500/10 to-amber-500/10 p-6 sm:p-8 lg:p-10">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300"><Instagram className="h-4 w-4" /> Instagram connection guide</span>
      <h2 id="instagram-guide-title" className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Connect your professional Instagram account</h2>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">Sign in with Instagram directly. The account you authorize is the one AskSales will use for messages and available features.</p>
      <Button className="mt-6 rounded-full bg-rose-600 text-white hover:bg-rose-700" onClick={onConnect} disabled={connecting}>{connecting ? "Opening Instagram…" : "Continue with Instagram"}<ArrowRight className="ml-2 h-4 w-4" /></Button>
    </div>
    <div className="grid gap-8 p-6 sm:p-8 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] lg:gap-10 lg:p-10">
      <div className="space-y-5">
        <GuideChecklist items={["Use an Instagram Business or Creator account; personal accounts must switch to professional first.", "Sign in as someone who manages that Instagram account.", "Review the permissions Instagram asks you to grant."]} />
        <div className="rounded-2xl border bg-muted/25 p-5"><p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-rose-600" /> What connects</p><p className="mt-2 text-sm leading-6 text-muted-foreground">Your selected professional account and its available messaging capabilities. A Facebook Page sign-in is not required for this route.</p></div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">What you will see</p>
        <div className="mt-5 space-y-8">
          <article className="rounded-2xl border bg-card p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-rose-600">Step 01</span><h3 className="mt-2 text-lg font-semibold">Sign in to Instagram</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Choose the Business or Creator account you want to use with AskSales.</p><GuideFigure image="instagram-signin-single" alt="Instagram sign-in example" className="mt-4" /></article>
          <article className="rounded-2xl border bg-card p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-rose-600">Step 02</span><h3 className="mt-2 text-lg font-semibold">Allow account access</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Review the Instagram permissions and approve access for the features you want to use.</p><GuideFigure image="instagram-consent-single" alt="Instagram permissions example" className="mt-4" /></article>
          <article className="flex gap-4 rounded-2xl border bg-rose-500/5 p-5"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" /><div><h3 className="text-sm font-semibold">Step 03 · Confirm the connected account</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Return to AskSales, select an account if prompted, and check the username and connection status before using messages.</p></div></article>
        </div>
      </div>
    </div>
  </section>;
}

export function FacebookConnectionGuide({ onConnect, connecting = false }: { onConnect: () => void; connecting?: boolean }) {
  return <section id="connection-guide" aria-labelledby="facebook-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-blue-500/5 p-6 sm:p-8 lg:p-10">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300"><MessageCircle className="h-4 w-4" /> Facebook Page guide</span>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-5 [&>div]:min-w-0 [&>div]:flex-[1_1_24rem]"><div><h2 id="facebook-guide-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">Connect a Facebook Page</h2><p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">Use your regular Facebook account to authorize a Page you manage and its Messenger conversations.</p></div><Button className="self-start rounded-full bg-blue-600 text-white hover:bg-blue-700" onClick={onConnect} disabled={connecting}>{connecting ? "Opening Facebook…" : "Continue with Facebook"}<ArrowRight className="ml-2 h-4 w-4" /></Button></div>
    </div>
    <div className="p-6 sm:p-8 lg:p-10">
      <GuideChecklist items={["Have a Facebook Page you can manage.", "Sign in with the Facebook account that has access to that Page.", "Personal profile inboxes are not supported; AskSales connects Page and Messenger activity."]} />
      <div className="mt-9 grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
        <article className="rounded-2xl border p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-blue-600">01 · Facebook Login</span><h3 className="mt-2 text-lg font-semibold">Continue as yourself</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Sign in with your normal Facebook account. You do not need a Meta developer account.</p><GuideFigure image="facebook-login" alt="Facebook Login example" className="mt-4" /></article>
        <article className="rounded-2xl border p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-blue-600">02 · Page access</span><h3 className="mt-2 text-lg font-semibold">Choose the Page</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Select the Page AskSales should use and review the requested Messenger access.</p><GuideFigure image="facebook-page" alt="Facebook Page selection example" className="mt-4" /></article>
      </div>
      <div className="mt-5 flex flex-col gap-4 rounded-2xl border bg-blue-500/5 p-5 sm:flex-row sm:items-center"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-sm font-bold text-blue-700">03</span><p className="flex-1 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Confirm in AskSales.</strong> Select a Page if prompted and verify its name and messaging status. A personal Facebook profile alone will not appear as connected.</p></div>
    </div>
  </section>;
}
