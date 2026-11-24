"use client";

import { useState } from "react";
import { Mail, Send } from "lucide-react";
import PublicLayout from "@/components/PublicLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BRAND_NAME, COMPANY_NAME, SUPPORT_EMAIL } from "@/lib/brand";

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });

  const openDraft = (event: React.FormEvent) => {
    event.preventDefault();
    const body = [`Name: ${form.name}`, `Reply email: ${form.email}`, "", form.message].join("\n");
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(form.subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <PublicLayout>
      <section className="border-b border-border pb-16 pt-32 sm:pb-20 sm:pt-36">
        <div className="mx-auto grid max-w-[1440px] gap-10 px-5 sm:px-8 lg:grid-cols-[1.1fr_.9fr] lg:px-12">
          <div><p className="font-mono text-[11px] uppercase tracking-[0.14em] text-primary">Contact</p><h1 className="mt-5 max-w-3xl text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] sm:text-5xl">Tell us where the workflow breaks.</h1></div>
          <p className="self-end text-lg leading-8 text-muted-foreground">Share the route, expected result, and the state you actually saw. Do not include passwords, provider secrets, or private lead data.</p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1.2fr_.8fr] lg:px-12 lg:py-24">
        <form onSubmit={openDraft} className="border border-border p-6 sm:p-9">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="name">Name</Label><Input id="name" required value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} autoComplete="name" /></div>
            <div className="space-y-2"><Label htmlFor="email">Reply email</Label><Input id="email" type="email" required value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} autoComplete="email" /></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="subject">Subject</Label><Input id="subject" required value={form.subject} onChange={(event) => setForm((value) => ({ ...value, subject: event.target.value }))} placeholder="Example: outreach approval did not resume" /></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="message">Details</Label><p id="message-hint" className="text-xs text-muted-foreground">Say what you asked for, which resource or action ID was shown, and what you expected next.</p><Textarea id="message" required rows={8} aria-describedby="message-hint" value={form.message} onChange={(event) => setForm((value) => ({ ...value, message: event.target.value }))} placeholder="For example: I approved an outreach send, but it did not resume." /></div>
          </div>
          <p className="mt-5 text-xs leading-5 text-muted-foreground">This opens a draft in your email application. {BRAND_NAME} does not claim the message was sent until your email provider sends it.</p>
          <Button type="submit" className="mt-6 gap-2">Open email draft<Send className="h-4 w-4" /></Button>
        </form>

        <aside className="border-y border-border py-7">
          <Mail className="h-5 w-5 text-primary" />
          <h2 className="mt-5 text-xl font-semibold">{SUPPORT_EMAIL}</h2>
          <p className="mt-3 leading-7 text-muted-foreground">{BRAND_NAME} is operated by {COMPANY_NAME}. For {BRAND_NAME} account, subscription or invoice help, use the email draft on this page. Your workspace’s Support area manages your own customers’ tickets.</p>
          <div className="mt-8 border-t border-border pt-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Useful details</p>
            <ul className="mt-4 space-y-3 text-sm"><li>Thread or campaign identifier</li><li>Provider and requested action</li><li>Last visible workflow state</li><li>Whether retrying changed the result</li></ul>
          </div>
        </aside>
      </section>
    </PublicLayout>
  );
}
