"use client";

import { useState } from "react";
import Image from "next/image";
import { ArrowRight, Check, CircleHelp, ExternalLink, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const images = {
  "whatsapp-login-single": [1123, 1401],
  "whatsapp-assets": [1101, 1429],
  "whatsapp-method": [1148, 1370],
  "whatsapp-phone-single": [883, 1780],
  "whatsapp-qr-single": [1148, 1370],
  "whatsapp-number": [1024, 1536],
  "whatsapp-migration": [1024, 1536],
  "instagram-signin-single": [1024, 1536],
  "instagram-consent-single": [1024, 1536],
  "facebook-login": [1024, 1536],
  "facebook-page": [1024, 1536],
  "gmail-account-single": [1145, 1374],
  "gmail-permissions-single": [1024, 1536],
  "resend-add-domain-single": [1536, 1024],
  "resend-records-single": [1536, 1024],
  "meta-ads-selection-single": [1024, 1536],
  "google-ads-account-single": [1024, 1536],
  "google-ads-details-single": [1536, 1024],
} as const;

export type GuideImageName = keyof typeof images;

export function GuideFigure({ image, alt, className }: { image: GuideImageName; alt: string; className?: string }) {
  const src = `/images/integration-guides/${image}.png`;
  const [width, height] = images[image];
  return <figure className={cn("w-fit max-w-full overflow-hidden rounded-2xl border bg-muted/20 p-2 shadow-sm sm:p-3", className)}>
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open full-size ${alt}`} className="block rounded-xl bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Image src={src} alt={alt} width={width} height={height} sizes="(max-width: 768px) 85vw, 680px" className="h-auto max-h-[34rem] w-auto max-w-full rounded-xl object-contain" />
    </a>
    <figcaption className="flex items-center gap-1 px-1 pt-2 text-xs leading-5 text-muted-foreground">Illustrative example; your provider screen may differ. Open to zoom <ExternalLink className="h-3 w-3" /></figcaption>
  </figure>;
}

export function GuideChecklist({ items, className }: { items: string[]; className?: string }) {
  return <div className={cn("rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5 sm:p-6", className)}>
    <p className="flex items-center gap-2 text-sm font-semibold"><CircleHelp className="h-4 w-4 text-amber-700 dark:text-amber-300" /> Before you start</p>
    <ul className="mt-4 grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
      {items.map(item => <li key={item} className="flex gap-2.5 text-sm leading-6 text-muted-foreground"><Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />{item}</li>)}
    </ul>
  </div>;
}

type WhatsAppStep = { title: string; body: string; image?: GuideImageName; alt?: string };
type WhatsAppMethod = {
  id: "business-app" | "new-number" | "migration";
  title: string;
  tag: string;
  description: string;
  checklist: string[];
  steps: WhatsAppStep[];
  note?: string;
};

const whatsappMethods: WhatsAppMethod[] = [
  {
    id: "business-app", title: "Use your Business app number", tag: "Existing app",
    description: "Connect your existing WhatsApp Business app number when Meta offers coexistence for your account.",
    checklist: [
      "Use a WhatsApp Business app number; personal WhatsApp accounts cannot connect.",
      "Have access to the Meta business portfolio that owns the number.",
      "Keep your phone and the Business app nearby for approval.",
    ],
    steps: [
      { title: "Continue with Facebook", body: "Select Connect WhatsApp and use the Facebook account that manages your business.", image: "whatsapp-login-single", alt: "WhatsApp Facebook Login example" },
      { title: "Select your business assets", body: "Choose the business portfolio and WhatsApp Business Account for this connection.", image: "whatsapp-assets", alt: "WhatsApp business asset selection example" },
      { title: "Choose the existing Business app", body: "If Meta offers coexistence, select the option for your existing WhatsApp Business app number.", image: "whatsapp-method", alt: "WhatsApp connection method example" },
      { title: "Approve the request on your phone", body: "Open the Meta message in WhatsApp Business and tap Connect if Meta sends one.", image: "whatsapp-phone-single", alt: "WhatsApp Business phone approval example" },
      { title: "Scan the code if asked", body: "Use the scanner opened by Meta to scan the code in the connection window. The code pictured here is not functional.", image: "whatsapp-qr-single", alt: "WhatsApp QR confirmation example" },
      { title: "Finish in AskSales", body: "Complete Meta's window and wait for the correct phone number and status to appear here." },
    ],
    note: "Meta controls which signup options appear. If coexistence is unavailable, use an eligible new number or contact support.",
  },
  {
    id: "new-number", title: "Connect a new number", tag: "New number",
    description: "Register an eligible business number for the WhatsApp Cloud API.",
    checklist: [
      "Have a phone number that can receive an SMS or voice code.",
      "Check that the number is eligible for WhatsApp Cloud API registration.",
      "Have access to the Meta business portfolio that will own it.",
    ],
    steps: [
      { title: "Continue with Facebook", body: "Select Connect WhatsApp and sign in as someone who manages the business.", image: "whatsapp-login-single", alt: "WhatsApp Facebook Login example" },
      { title: "Select business assets", body: "Choose or create the business portfolio and WhatsApp Business Account.", image: "whatsapp-assets", alt: "WhatsApp business asset selection example" },
      { title: "Add the number", body: "Enter the number with its country code and choose SMS or voice verification.", image: "whatsapp-number", alt: "WhatsApp phone number entry example" },
      { title: "Verify and finish", body: "Enter the one-time code in Meta, then confirm the connected number in AskSales." },
    ],
  },
  {
    id: "migration", title: "Move from another provider", tag: "Migration",
    description: "Move a number already on the WhatsApp Business Platform with another provider.",
    checklist: [
      "Have admin access to the source WhatsApp Business Account and destination business portfolio.",
      "Follow your current provider's number-release instructions.",
      "Keep access to the number in case Meta requests verification.",
    ],
    steps: [
      { title: "Prepare the current account", body: "Check the number's security settings in WhatsApp Manager and complete your provider's release steps.", image: "whatsapp-migration", alt: "WhatsApp Manager number settings example" },
      { title: "Continue with Facebook", body: "Select Connect WhatsApp and sign in to the destination business.", image: "whatsapp-login-single", alt: "WhatsApp Facebook Login example" },
      { title: "Select the destination", body: "Choose the business portfolio and WhatsApp Business Account that should receive the number.", image: "whatsapp-assets", alt: "WhatsApp business asset selection example" },
      { title: "Move the number", body: "Follow Meta's migration prompts and verify the number when requested.", image: "whatsapp-number", alt: "WhatsApp phone number entry example" },
      { title: "Check the result", body: "Confirm the intended number is connected in AskSales before sending messages." },
    ],
    note: "Migration availability depends on Meta and your current provider. Ask support if Meta does not offer the move.",
  },
];

export function WhatsAppConnectionGuide({ onConnect, connecting = false }: { onConnect: () => void; connecting?: boolean }) {
  const [selectedId, setSelectedId] = useState<WhatsAppMethod["id"]>("business-app");
  const selected = whatsappMethods.find(method => method.id === selectedId) ?? whatsappMethods[0];

  return <section id="connection-guide" aria-labelledby="whatsapp-guide-title" className="scroll-mt-6 overflow-hidden rounded-3xl border bg-card shadow-sm">
    <div className="border-b bg-gradient-to-br from-emerald-500/10 via-card to-card p-6 sm:p-8 lg:p-10">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300"><ListChecks className="h-4 w-4" /> Connection guide</span>
      <h2 id="whatsapp-guide-title" className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">How to connect WhatsApp</h2>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">Pick the option that matches your number. You will make the same choice inside Meta when that option is available.</p>
      <div className="mt-7 grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
        {whatsappMethods.map(method => <button key={method.id} type="button" aria-pressed={selected.id === method.id} onClick={() => setSelectedId(method.id)} className={cn("rounded-2xl border bg-card p-5 text-left transition-colors hover:border-emerald-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected.id === method.id && "border-emerald-500/50 bg-emerald-500/5")}>
          <span className="flex items-start justify-between gap-3"><span className="text-sm font-semibold">{method.title}</span>{selected.id === method.id && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}</span>
          <span className="mt-1 block text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">{method.tag}</span>
          <span className="mt-3 block text-xs leading-5 text-muted-foreground">{method.description}</span>
        </button>)}
      </div>
    </div>
    <div className="p-6 sm:p-8 lg:p-10">
      <h3 className="text-xl font-semibold">{selected.title}</h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{selected.description}</p>
      <GuideChecklist items={selected.checklist} className="mt-6" />
      {selected.note && <p className="mt-4 rounded-xl border bg-muted/35 p-4 text-xs leading-6 text-muted-foreground">{selected.note}</p>}
      <p className="mt-9 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.13em] text-emerald-700 dark:text-emerald-300"><Check className="h-4 w-4" /> Connection steps</p>
      <ol className="mt-5 max-w-4xl">
        {selected.steps.map((step, index) => <li key={step.title} className="relative flex gap-4 pb-9 last:pb-0 sm:gap-5">
          {index < selected.steps.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-8 w-px bg-border" />}
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-xs font-semibold text-emerald-700 dark:text-emerald-300">{index + 1}</span>
          <div className="min-w-0 flex-1 pt-0.5"><p className="text-sm font-semibold">{step.title}</p><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{step.body}</p>{step.image && <GuideFigure image={step.image} alt={step.alt ?? step.title} className="mt-4" />}</div>
        </li>)}
      </ol>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-muted/25 p-5"><div><p className="text-sm font-semibold">Ready to connect?</p><p className="mt-1 text-xs text-muted-foreground">Meta will open the authorization window and return you to AskSales.</p></div><Button className="rounded-full" onClick={onConnect} disabled={connecting}>{connecting ? "Opening Meta…" : "Connect WhatsApp"}<ArrowRight className="ml-2 h-4 w-4" /></Button></div>
    </div>
  </section>;
}
