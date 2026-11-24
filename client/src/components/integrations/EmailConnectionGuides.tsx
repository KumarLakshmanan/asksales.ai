"use client";

import { ArrowRight, CheckCircle2, Globe2, Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuideChecklist, GuideFigure } from "./ConnectionGuide";

export function GmailConnectionGuide({ onConnect, connecting = false }: { onConnect: () => void; connecting?: boolean }) {
  return <section id="connection-guide" aria-labelledby="gmail-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-gradient-to-r from-rose-500/5 via-card to-indigo-500/5 p-6 sm:p-8 lg:p-10">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300"><Mail className="h-4 w-4" /> Gmail connection guide</span>
      <h2 id="gmail-guide-title" className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Connect Gmail with Google</h2>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">Authorize a Gmail or Google Workspace mailbox for sending and reply sync. You will choose the account in the Google sign-in window.</p>
      <Button className="mt-6 rounded-full" onClick={onConnect} disabled={connecting}>{connecting ? "Opening Google…" : "Connect Gmail"}<ArrowRight className="ml-2 h-4 w-4" /></Button>
    </div>
    <div className="p-6 sm:p-8 lg:p-10">
      <GuideChecklist items={["Have access to the Gmail or Google Workspace mailbox you want to use.", "Choose the correct Google account if more than one is signed in.", "Review the Gmail permissions for sending and reply sync."]} />
      <div className="mt-9 grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
        <article className="rounded-2xl border p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-rose-600">Step 01</span><h3 className="mt-2 text-lg font-semibold">Choose the Google account</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Select the mailbox you want AskSales to send from.</p><GuideFigure image="gmail-account-single" alt="Google account chooser example" className="mt-4" /></article>
        <article className="rounded-2xl border p-5 sm:p-6"><span className="text-xs font-bold uppercase tracking-wide text-rose-600">Step 02</span><h3 className="mt-2 text-lg font-semibold">Approve Gmail access</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Review the Google permission screen and continue if you agree.</p><GuideFigure image="gmail-permissions-single" alt="Google Gmail permission example" className="mt-4" /></article>
      </div>
      <div className="mt-5 flex gap-3 rounded-2xl border bg-rose-500/5 p-5"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" /><p className="text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Step 03 · Check the mailbox.</strong> Return to AskSales and confirm the Gmail address is connected. Restart reply sync if the status asks for it.</p></div>
    </div>
  </section>;
}

export function ResendConnectionGuide({ onOpenSetup }: { onOpenSetup: () => void }) {
  return <section id="resend-guide" aria-labelledby="resend-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-indigo-500/5 p-6 sm:p-8 lg:p-10">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-700 dark:text-indigo-300"><Globe2 className="h-4 w-4" /> Resend sending-domain guide</span>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-5 [&>div]:min-w-0 [&>div]:flex-[1_1_24rem]"><div><h2 id="resend-guide-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">Verify a sending domain</h2><p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">AskSales uses Resend for domain sending. Add a domain here, publish its DNS records, then create a sender address.</p></div><Button variant="outline" className="self-start rounded-full" onClick={onOpenSetup}>Open sending domains<ArrowRight className="ml-2 h-4 w-4" /></Button></div>
    </div>
    <div className="p-6 sm:p-8 lg:p-10">
      <GuideChecklist items={["Own the domain you want to send from.", "Have access to its DNS provider so you can publish records.", "Use the exact DNS values shown for your domain; the example images contain placeholders."]} />
      <div className="mt-9 space-y-7">
        <article className="grid gap-5 rounded-2xl border p-5 sm:p-6 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]"><div><span className="text-xs font-bold uppercase tracking-wide text-indigo-600">Step 01</span><h3 className="mt-2 text-lg font-semibold">Add the domain</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Enter the sending domain in the form below. AskSales creates the Resend domain connection.</p></div><GuideFigure image="resend-add-domain-single" alt="AskSales add sending domain example" /></article>
        <article className="grid gap-5 rounded-2xl border p-5 sm:p-6 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]"><div><span className="text-xs font-bold uppercase tracking-wide text-indigo-600">Step 02</span><h3 className="mt-2 text-lg font-semibold">Publish and verify DNS</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Copy the records from your actual domain card into your DNS provider. After they propagate, select Check verification.</p></div><GuideFigure image="resend-records-single" alt="Resend DNS records and verification example" /></article>
        <div className="flex gap-4 rounded-2xl border bg-indigo-500/5 p-5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-sm font-bold text-indigo-700">03</span><div><h3 className="text-sm font-semibold">Add a sender and test it</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Once the domain says Verified, add a sender address on it and send a test email to an inbox you control.</p></div><Send className="ml-auto hidden h-5 w-5 shrink-0 text-indigo-600 sm:block" /></div>
      </div>
    </div>
  </section>;
}
