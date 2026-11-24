"use client";

import { ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuideChecklist } from "@/components/integrations/ConnectionGuide";

const steps = [
  { title: "Prepare your sender and template", body: "In MSG91 SMS, select an approved six-character Sender ID and an active SMS template. Complete the DLT registration required for your destination. Use one text variable for the message, for example ##message##." },
  { title: "Copy your connection details", body: "Copy the MSG91 Auth Key with SMS API access, the Sender ID, and the SMS Template ID. The Template ID is the identifier from MSG91; enter the variable name without the surrounding ## marks." },
  { title: "Verify and save in AskSales", body: "Enter the details in SMS sender settings. Test connection checks that the key, sender, and template match. Save connection verifies and stores the settings securely. Confirm that the connection shows Connected." },
  { title: "Receive delivery reports", body: "In MSG91 SMS → Webhook (New), create an OnReportReceived webhook. Use the delivery callback URL and JSON fields shown under Delivery and replies. Delivery reports update your SMS history and Events and activity." },
  { title: "Enable replies when your account supports them", body: "If your MSG91 plan includes an inbound SMS number or longcode, configure its callback with the incoming SMS URL and fields below. Receiving replies requires that inbound service to be enabled in MSG91." },
];

export function MSG91ConnectionGuide({ onConfigure }: { onConfigure: () => void }) {
  return <section aria-label="MSG91 connection guide" className="space-y-6">
    <GuideChecklist items={["Access to your MSG91 account and an SMS API Auth Key.", "An approved Sender ID and active SMS template.", "Exactly one message variable in the template.", "MSG91 SMS balance for outreach; an inbound number if you need replies."]} />
    <ol className="space-y-6">
      {steps.map((step, index) => <li key={step.title} className="flex gap-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-sm font-semibold text-amber-700 dark:text-amber-300">{index + 1}</span>
        <div><h3 className="text-sm font-semibold">{step.title}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p></div>
      </li>)}
    </ol>
    <div className="flex flex-wrap gap-4 text-sm">
      <a href="https://docs.msg91.com/sms/send-sms" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">MSG91 SMS documentation<ExternalLink className="h-3.5 w-3.5" /></a>
      <a href="https://msg91.com/help/webhook-new/how-to-receive-sms-delivery-reports-via-webhook-new" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Delivery webhook guide<ExternalLink className="h-3.5 w-3.5" /></a>
    </div>
    <Button className="rounded-full" onClick={onConfigure}>Open sender settings<ArrowRight className="ml-2 h-4 w-4" /></Button>
  </section>;
}
