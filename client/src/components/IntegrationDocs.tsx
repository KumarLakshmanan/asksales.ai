/**
 * Integration Documentation Component
 * Shows step-by-step setup instructions for each integration
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, ExternalLink, BookOpen, Play, Lightbulb, AlertTriangle, Wrench, Sparkles } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/brand";

interface Step {
  title: string;
  description: string;
  action?: string;
  link?: { url: string; text: string };
  code?: string;
  note?: string;
  warning?: string;
  image?: string;
}

interface IntegrationDocsProps {
  platform?: string;
  overview?: string;
  requirements?: string[];
  steps?: Step[];
  tips?: string[];
  troubleshooting?: { problem: string; solution: string }[];
  title?: string;
  className?: string;
  docs?: {
    platform: string;
    overview: string;
    requirements?: string[];
    steps: Step[];
    tips?: string[];
    troubleshooting?: { problem: string; solution: string }[];
  };
  embedded?: boolean;
}

export function IntegrationDocs(props: IntegrationDocsProps) {
  const {
    title,
    className,
    docs,
    embedded = false,
  } = props;
  const platform = props.platform || docs?.platform || "";
  const overview = props.overview || docs?.overview || "";
  const requirements = props.requirements || docs?.requirements;
  const steps = props.steps || docs?.steps || [];
  const tips = props.tips || docs?.tips;
  const troubleshooting = props.troubleshooting || docs?.troubleshooting;
  const [isOpen, setIsOpen] = useState(embedded); // Default to open if embedded

  const Content = (
    <div className={cn("space-y-8", embedded ? "" : "pt-0")}>
      {/* Overview */}
      <div className={cn("rounded-xl p-5 border dark:border-border/30", embedded ? "bg-muted/30 border-border/50 shadow-inner" : "bg-white dark:bg-gray-800/50 mt-4")}>
        <div className="flex items-center gap-2.5 mb-3">
           <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <BookOpen className="w-3 h-3" />
           </div>
           <h4 className="text-xs font-semibold text-muted-foreground">Overview</h4>
        </div>
        <p className="text-sm text-muted-foreground font-medium leading-relaxed">{overview}</p>
      </div>

      {/* Requirements */}
      {requirements && requirements.length > 0 && (
        <div className={cn("rounded-xl p-5 border dark:border-border/30", embedded ? "bg-muted/30 border-border/50 shadow-inner" : "bg-white dark:bg-gray-800/50")}>
          <div className="flex items-center gap-2.5 mb-4">
             <div className="w-6 h-6 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
                <Lightbulb className="w-3 h-3" />
             </div>
             <h4 className="text-xs font-semibold text-muted-foreground">Requirements</h4>
          </div>
          <ul className="grid grid-cols-1 gap-2">
            {requirements.map((req, i) => (
              <li key={i} className="text-xs text-muted-foreground flex items-center gap-3 p-3 rounded-xl bg-background/50 border border-border/20 group hover:border-amber-500/30 transition-colors">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40 group-hover:bg-amber-500 transition-colors" />
                <span className="font-semibold">{req}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Steps */}
      <div className="space-y-4">
        <div className="flex items-center gap-2.5 px-2">
           <div className="w-6 h-6 rounded-lg bg-indigo-600/10 flex items-center justify-center text-indigo-600">
              <Play className="w-3 h-3" />
           </div>
           <h4 className="text-xs font-semibold text-muted-foreground">Integration Steps</h4>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {steps.map((step, index) => (
            <div key={index} className={cn("rounded-xl p-5 border dark:border-border/30", embedded ? "bg-muted/30 border-border/50 shadow-inner" : "bg-white dark:bg-gray-800/50")}>
              <div className="flex items-start gap-5">
                <div className="flex-shrink-0 w-8 h-8 bg-indigo-600 text-white rounded-lg flex items-center justify-center text-xs font-black shadow-lg shadow-indigo-600/20">
                  {String(index + 1).padStart(2, '0')}
                </div>
                <div className="flex-1 space-y-3 pt-1">
                   <h5 className="text-sm font-bold tracking-tight text-foreground">{step.title}</h5>
                   <div className="text-xs text-muted-foreground font-medium leading-relaxed opacity-70">{step.description}</div>

                  {step.note && (
                    <Callout tone="info" size="sm" icon={Lightbulb}>
                       <p>{step.note}</p>
                    </Callout>
                  )}

                  {step.warning && (
                    <Callout tone="warning" size="sm">
                       <p>{step.warning}</p>
                    </Callout>
                  )}

                  {step.action && (
                    <div className="flex items-center gap-2 py-0.5">
                      <div className="p-1 rounded-full bg-emerald-500/10">
                        <Play className="w-2.5 h-2.5 text-emerald-600" />
                      </div>
                      <span className="text-emerald-700 font-semibold text-xs">{step.action}</span>
                    </div>
                  )}

                  {step.link && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 px-4 rounded-lg font-black text-[10px] uppercase tracking-widest bg-background border-border/20 shadow-sm hover:bg-muted transition-all flex items-center gap-2"
                      onClick={() => window.open(step.link!.url, "_blank")}
                    >
                      {step.link.text}
                      <ExternalLink className="w-3 h-3 opacity-40" />
                    </Button>
                  )}
 
                  {step.code && (
                    <div className="relative mt-2 group">
                       <div className="absolute inset-0 bg-indigo-600/5 blur-xl opacity-0 group-hover:opacity-100 transition-opacity" />
                       <div className="relative p-4 rounded-xl bg-muted/50 border border-border/30 font-mono text-[10px] flex items-center justify-between gap-3 overflow-hidden shadow-inner">
                          <code className="text-indigo-600 dark:text-indigo-400 font-bold truncate">{step.code}</code>
                          <CopyButton
                            value={step.code}
                            label="Copy code"
                            iconOnly
                            variant="ghost"
                            className="h-8 w-8 rounded-lg shrink-0"
                          />
                       </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tips */}
      {tips && tips.length > 0 && (
        <div className="space-y-4">
           <div className="flex items-center gap-2.5 px-2">
              <div className="w-6 h-6 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                 <Sparkles className="w-3 h-3" />
              </div>
               <h4 className="text-xs font-semibold text-muted-foreground">Pro Tips</h4>
           </div>
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {tips.map((tip, i) => (
                <div key={i} className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/10 flex items-start gap-3">
                   <div className="shrink-0 rounded-lg bg-background p-1.5 shadow-sm">
                      <Lightbulb className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                   </div>
                   <p className="text-xs leading-relaxed text-emerald-800 dark:text-emerald-300">{tip}</p>
                </div>
              ))}
           </div>
        </div>
      )}

      {/* Troubleshooting */}
      {troubleshooting && troubleshooting.length > 0 && (
        <div className="space-y-4">
           <div className="flex items-center gap-2.5 px-2">
              <div className="w-6 h-6 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-500">
                 <Wrench className="w-3 h-3" />
              </div>
               <h4 className="text-xs font-semibold text-muted-foreground">Troubleshooting</h4>
           </div>
           <div className="grid grid-cols-1 gap-3">
            {troubleshooting.map((item, i) => (
              <div key={i} className="rounded-xl border border-border/30 bg-muted/20 overflow-hidden shadow-inner">
                <div className="p-5 space-y-3">
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
                    <h5 className="font-semibold text-rose-600 text-xs">{item.problem}</h5>
                  </div>
                  <p className="text-xs font-semibold text-muted-foreground leading-relaxed pl-6 border-l-2 border-rose-500/20">{item.solution}</p>
                </div>
              </div>
            ))}
           </div>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return <div className={className}>{Content}</div>;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <Card className="border-border/40 bg-card/30 h-full overflow-hidden rounded-xl shadow-lg shadow-black/5">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/10 transition-colors py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary rounded-lg shadow-lg shadow-primary/20">
                  <BookOpen className="w-4 h-4 text-white" />
                </div>
                <div>
                  <CardTitle className="text-base font-bold tracking-tight">{title || `Guide: ${platform}`}</CardTitle>
                  <p className="text-[9px] font-black uppercase tracking-widest opacity-40 mt-0.5">
                    Step-by-step instructions
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg bg-background/50">
                {isOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="px-5 pb-6">
            {Content}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// Pre-configured documentation for each platform
export const INTEGRATION_DOCS = {
  meta: {
    platform: "Meta (Facebook/Instagram)",
    overview: "Connect your Meta accounts for Facebook and Instagram advertising and messaging. Credentials are managed by your administrator.",
    requirements: [
      "A Facebook Business account",
      "A Facebook Page for your business",
      "An Instagram Professional account connected to your Facebook Page",
      "Admin has configured Meta App credentials in the Admin Panel",
    ],
    steps: [
      {
        title: "Check Connection Status",
        description: "The Meta App credentials are managed by your administrator. Check that the status shows 'Connected' or 'Configured' on this page.",
        note: "If not configured, contact your admin to set up Meta App credentials in the Admin Panel → Integrations.",
      },
      {
        title: "Connect Your Facebook Page",
        description: "Click the 'Connect Facebook' button. You'll be redirected to Facebook to authorize your Page.",
        action: "Click 'Connect Facebook' button",
      },
      {
        title: "Select Your Page",
        description: "In the Facebook authorization dialog, select the Facebook Page you want to connect and grant the requested permissions.",
      },
      {
        title: "Connect Instagram (Optional)",
        description: "If you want Instagram messaging, click 'Connect Instagram'. Select your Instagram Professional account linked to your Facebook Page.",
        action: "Click 'Connect Instagram' button",
      },
      {
        title: "Verify Connection",
        description: "After redirecting back, you should see your accounts connected with a green 'Connected' badge.",
      },
    ],
    tips: [
      "Your administrator manages the Meta App credentials — you only need to connect your accounts via OAuth",
      "Test the connection by sending a test message through the platform",
    ],
    troubleshooting: [
      {
        problem: "'Not Configured' shown on the page",
        solution: "Contact your administrator to configure Meta App credentials in Admin Panel → Integrations",
      },
      {
        problem: "Token Expired",
        solution: "Click 'Reconnect' to refresh your authorization via OAuth",
      },
      {
        problem: "Permission Denied",
        solution: "Ensure you have admin access to the Facebook Page and the required permissions are approved",
      },
    ],
  },

  instagram: {
    platform: "Instagram Messaging",
    overview: "Sign in directly with Instagram to connect your Business or Creator account. A Facebook Page is not required.",
    requirements: ["An Instagram Business or Creator account", "Access to the Instagram account you want to connect"],
    steps: [
      { title: "Prepare your account", description: "If you use a personal account, switch to a Business or Creator account in Instagram settings first." },
      { title: "Continue with Instagram", description: "Click Continue with Instagram and sign in to the account you want to connect." },
      { title: "Allow access", description: "Review and allow account and messaging access in Instagram's consent screen." },
      { title: "Check your connection", description: "Return to AskSales and check the account name and connection status. If you have connected several accounts, choose the one you want to use." },
    ],
    tips: ["You do not need your own developer app or access token.", "Receive a message from a customer before replying through Instagram messaging."],
    troubleshooting: [
      { problem: "Instagram Login is not configured", solution: "Contact support so your administrator can finish the shared Instagram app setup." },
      { problem: "Personal account cannot connect", solution: "Switch to a Business or Creator account in Instagram settings, then try again." },
      { problem: "Permission was denied or authorization expired", solution: "Click Reconnect with Instagram and allow the requested permissions." },
      { problem: "Incoming messages are not ready", solution: "Reconnect to retry message setup. Contact support if the issue continues." },
    ],
  },

  gmail: {
    platform: "Gmail",
    overview: `Connect your Gmail account to send and receive emails directly from ${BRAND_NAME} using Google OAuth.`,
    requirements: [
      "A Google account with Gmail",
      "Two-factor authentication enabled (recommended)",
    ],
    steps: [
      {
        title: "Click 'Connect Gmail'",
        description: "Click the Connect Gmail button to start the OAuth flow.",
        action: "Click 'Connect Gmail' button",
      },
      {
        title: "Sign in to Google",
        description: "Select your Google account or sign in with your credentials.",
      },
      {
        title: "Grant Permissions",
        description: "Review and accept the requested permissions: read, send, and manage emails.",
        note: "We only request the minimum permissions needed for email functionality.",
      },
      {
        title: `Return to ${BRAND_NAME}`,
        description: `After granting permissions, you'll be redirected back to ${BRAND_NAME} and your Gmail will be connected.`,
      },
    ],
    tips: [
      "Use a dedicated business email for outreach campaigns",
      "Gmail has daily sending limits (500/day for personal, 2000/day for Workspace)",
      "Consider using Google Workspace for higher limits and better deliverability",
    ],
    troubleshooting: [
      {
        problem: "Authorization failed",
        solution: "Try clearing your browser cache and cookies, then reconnect",
      },
      {
        problem: "Token expired",
        solution: "Click 'Reconnect' to refresh your authorization",
      },
    ],
  },

  resend: {
    platform: "Resend Email (Custom Domain)",
    overview: "Send outreach emails from your own domain using Resend. Add your domain, configure DNS records with your provider, verify, and start sending.",
    requirements: [
      "A domain you own (e.g. yourdomain.com)",
      "Access to your domain's DNS settings (Cloudflare, GoDaddy, Namecheap, etc.)",
    ],
    steps: [
      {
        title: "Add Your Domain",
        description: "Enter your domain name (e.g. yourdomain.com or mail.yourdomain.com) in the field above and click 'Add Domain'.",
        action: "Type your domain and click 'Add Domain'",
      },
      {
        title: "Copy DNS Records",
        description: "After adding the domain, you'll see a table of DNS records (MX, TXT, CNAME). Copy each record and add them to your DNS provider.",
        note: "You'll typically need to add SPF (MX + TXT), DKIM (3 CNAME records), and optionally DMARC.",
      },
      {
        title: "Add Records to Your DNS Provider",
        description: "Log in to your domain provider (Cloudflare, GoDaddy, Namecheap, Route 53, etc.) and add each DNS record exactly as shown.",
        warning: "DNS propagation can take up to 72 hours, but usually completes within a few minutes to an hour.",
      },
      {
        title: "Verify Domain",
        description: "Once DNS records are configured, click 'Verify Domain' to check the records. The status will change to 'Verified' when successful.",
        action: "Click 'Verify Domain' button",
      },
      {
        title: "Send a Test Email",
        description: "After verification, enter a recipient email and click 'Send Test' to confirm everything is working.",
        action: "Enter an email and click 'Send Test'",
      },
    ],
    tips: [
      "Use a subdomain like mail.yourdomain.com to avoid conflicts with existing email setup",
      "If using Cloudflare, make sure DNS proxy (orange cloud) is OFF for CNAME records",
      "DMARC record is optional but recommended for better deliverability",
      "Keep both SPF records (MX and TXT) — they're required for Resend to work",
    ],
    troubleshooting: [
      {
        problem: "Domain stuck in 'Pending' status",
        solution: "Double-check that all DNS records are added correctly. DNS propagation can take up to 72 hours. Try clicking 'Verify Domain' again after waiting.",
      },
      {
        problem: "DKIM records not verifying",
        solution: "Ensure CNAME records are added without the trailing dot. If using Cloudflare, disable the proxy (orange cloud icon).",
      },
      {
        problem: "Emails going to spam",
        solution: "Make sure SPF, DKIM, and DMARC records are all properly configured and verified.",
      },
    ],
  },

  msg91: {
    platform: "MSG91 SMS",
    overview: "Connect MSG91 to send SMS messages to your leads and customers.",
    requirements: [
      "An MSG91 account",
      "DLT registration (required for India)",
      "Sender ID (6 characters for promotional, entity name for transactional)",
      "An approved MSG91 SMS Template/Flow with one text variable",
      "API Key from MSG91 dashboard",
    ],
    steps: [
      {
        title: "Create MSG91 Account",
        description: "Sign up for an MSG91 account if you don't have one.",
        link: { url: "https://msg91.com/signup", text: "Sign up for MSG91" },
      },
      {
        title: "Get Your API Key",
        description: "Log in to MSG91 → Go to API → Copy your Auth Key.",
        link: { url: "https://control.msg91.com/api/", text: "MSG91 API Dashboard" },
      },
      {
        title: "Complete DLT Registration (India)",
        description: "For sending SMS in India, you must register with DLT. MSG91 can help with this process.",
        warning: "DLT registration is mandatory for SMS in India. Non-compliance can result in message blocking.",
      },
      {
        title: "Create Sender ID",
        description: "In MSG91 dashboard, create a Sender ID (6 characters like 'SALMKT' or your entity name).",
      },
      {
        title: "Create SMS Templates",
        description: "Create and approve an SMS Template in MSG91, then copy its Template ID for use as flow_id.",
        note: "Include one text variable for the complete AskSales message and keep its case-sensitive variable name.",
        link: { url: "https://msg91.com/help/text-sms/where-to-find-my-flow-id", text: "Find the MSG91 Flow ID" },
      },
      {
        title: "Enter Credentials",
        description: "Enter your MSG91 Auth Key, Sender ID, Flow/Template ID, and the exact message variable name in the form.",
      },
      {
        title: "Test the Connection",
        description: "Validate the Auth Key against MSG91 before using the flow for outreach.",
        action: "Click 'Test'",
      },
      {
        title: "Use SMS replies",
        description: "If your MSG91 plan supports inbound SMS, contact support to enable replies for your connected number.",
        link: { url: "https://msg91.com/help/virtual-number/how-to-activate-a-long-code", text: "MSG91 longcode availability" },
      },
    ],
    tips: [
      "Use template IDs for faster delivery and better compliance",
      "Keep messages under 160 characters to avoid splitting",
      "Use promotional routes (Route 1) for marketing and transactional (Route 4) for important notifications",
    ],
    troubleshooting: [
      {
        problem: "Messages not delivered",
        solution: "Check DLT registration status and template approval",
      },
      {
        problem: "Invalid Sender ID",
        solution: "Sender ID must be approved in MSG91 and registered with DLT",
      },
      {
        problem: "Insufficient balance",
        solution: "Top up your MSG91 account with SMS credits",
      },
    ],
  },

  whatsapp: {
    platform: "WhatsApp Business",
    overview: "Connect WhatsApp Business API to send messages and automate conversations with customers.",
    requirements: [
      "A WhatsApp Business account",
      "Meta Business verification",
      "A phone number dedicated to WhatsApp Business",
      "Meta App with WhatsApp product enabled",
    ],
    steps: [
      {
        title: "Set Up Meta Business Account",
        description: "Create or verify your Meta Business account for WhatsApp API access.",
        link: { url: "https://business.facebook.com/", text: "Meta Business Suite" },
      },
      {
        title: "Add WhatsApp to Meta App",
        description: "In Meta App Dashboard → Add Product → WhatsApp → Set Up.",
      },
      {
        title: "Register Phone Number",
        description: "In WhatsApp Business settings, add and verify a phone number for your business.",
        warning: "This phone number cannot be used with regular WhatsApp app.",
      },
      {
        title: "Get WhatsApp Phone Number ID",
        description: "In WhatsApp Business settings, copy your Phone Number ID.",
      },
      {
        title: "Get WhatsApp Business Account ID",
        description: "Copy your WhatsApp Business Account ID from the settings.",
      },
      {
        title: "Generate Access Token",
        description: "Create a System User and generate a permanent access token with WhatsApp permissions.",
      },
      {
        title: "Create Message Templates",
        description: "Create and submit message templates for approval. Templates are required for business-initiated conversations.",
        note: "Template approval can take 24-48 hours.",
      },
      {
        title: "Enter Credentials",
        description: "Enter your Phone Number ID, Business Account ID, and Access Token.",
      },
    ],
    tips: [
      "Start with template messages for outreach, then continue conversations freely",
      "Respond to customer messages within 24 hours to stay in the messaging window",
      "Use interactive message templates with buttons for better engagement",
    ],
    troubleshooting: [
      {
        problem: "Message not delivered",
        solution: "Check if the recipient has WhatsApp and your template is approved",
      },
      {
        problem: "Business verification pending",
        solution: "Complete Meta Business verification with required documents",
      },
      {
        problem: "Template rejected",
        solution: "Review Meta's template guidelines and resubmit with corrections",
      },
    ],
  },

  facebook: {
    platform: "Facebook Messenger",
    overview: "Sign in with your Facebook account, then connect a Page you manage to use Page messaging and supported Page features.",
    requirements: ["A Facebook account with permission to manage a Page and its messages", "A Facebook Page to connect"],
    steps: [
      { title: "Continue with Facebook", description: "Click Continue with Facebook and sign in to your Facebook account." },
      { title: "Authorize your Pages", description: "Choose the Pages you want to authorize and grant the requested access." },
      { title: "Choose a Page", description: "Return to AskSales and select the Page you want to use for Messenger." },
      { title: "Check the connection", description: "Confirm the Page name and connection status, then open Messenger conversations." },
    ],
    tips: ["Ordinary customers use the shared AskSales app; you do not need a developer account, app credentials, or a copied access token.", "A personal Facebook account can sign in, but personal-profile inboxes and personal-profile publishing are not supported by this Page integration."],
    troubleshooting: [
      { problem: "No Pages found", solution: "Sign in to the Facebook account that manages your Page and allow Page access. If you only have a personal profile, create a Page first." },
      { problem: "Permissions are missing", solution: "Reconnect with Facebook and grant access to the Page and its messages." },
      { problem: "Facebook Login is unavailable", solution: "Contact support to check the shared app configuration and access approval." },
      { problem: "Authorization expired", solution: "Reconnect your Facebook account and select your Page again." },
    ],
  },

  twitter: {
    platform: "Twitter / X",
    overview: "Connect your Twitter/X account to send DMs, schedule tweets, and track engagement through the Twitter API v2.",
    requirements: [
      "A Twitter/X account",
      "A Twitter Developer account with API access",
      "An App created in the Twitter Developer Portal",
      "OAuth 2.0 credentials (Client ID and Client Secret)",
    ],
    steps: [
      {
        title: "Create a Twitter Developer Account",
        description: "Sign up for a Twitter Developer account at the developer portal.",
        link: { url: "https://developer.x.com/en/portal/petition/essential/basic-info", text: "Open X Developer Portal" },
      },
      {
        title: "Create a New App",
        description: "In the Developer Portal, go to Projects & Apps and create a new app.",
        note: "Choose the appropriate access level (Basic, Pro, or Enterprise) based on your needs.",
      },
      {
        title: "Get API Keys",
        description: "Go to your app's Keys and Tokens page. Copy the API Key (Consumer Key) and API Secret (Consumer Secret).",
        note: "Store these securely — they cannot be viewed again after leaving the page.",
      },
      {
        title: "Configure OAuth 2.0",
        description: "In your app settings, enable OAuth 2.0 and set the Callback URL to match your redirect URI.",
        code: "https://your-domain.com/api/twitter/oauth/callback",
      },
    ],
    tips: [
      "Twitter API v2 has rate limits — check your tier's limits before bulk operations",
      "Use OAuth 2.0 with PKCE for user-context requests",
      "DMs require elevated access — apply for the appropriate tier",
      "Monitor your API usage in the Developer Portal dashboard",
    ],
    troubleshooting: [
      {
        problem: "API key not working",
        solution: "Regenerate your keys in the Developer Portal. Ensure the app has the correct access level.",
      },
      {
        problem: "Rate limited",
        solution: "Check your tier's rate limits. Consider upgrading your access level for higher limits.",
      },
      {
        problem: "DMs not sending",
        solution: "Ensure your app has DM permissions and the recipient allows DMs from non-followers.",
      },
    ],
  },

  linkedin: {
    platform: "LinkedIn",
    overview: "Connect your LinkedIn account for professional networking outreach, InMail messaging, and lead generation through the LinkedIn API.",
    requirements: [
      "A LinkedIn account",
      "A LinkedIn Developer account",
      "An app created in the LinkedIn Developer Portal",
      "OAuth 2.0 credentials (Client ID and Client Secret)",
    ],
    steps: [
      {
        title: "Create a LinkedIn Developer App",
        description: "Go to the LinkedIn Developer Portal and create a new application.",
        link: { url: "https://www.linkedin.com/developers/apps/new", text: "Create LinkedIn App" },
      },
      {
        title: "Verify Your App",
        description: "Associate your app with a LinkedIn Company Page and complete the verification process.",
        note: "You must be a super admin of the LinkedIn Company Page.",
      },
      {
        title: "Get Client Credentials",
        description: "In your app's Auth settings, copy the Client ID and Client Secret.",
      },
      {
        title: "Configure OAuth 2.0 Redirect",
        description: "Add your authorized redirect URL in the app's Auth settings.",
        code: "https://your-domain.com/api/linkedin/oauth/callback",
      },
      {
        title: "Request Required Scopes",
        description: "In the Products tab, request access to: Sign In with LinkedIn, Share on LinkedIn, and Marketing Developer Platform.",
        note: "Some APIs require partner-level access. Apply through LinkedIn's partner program if needed.",
      },
    ],
    tips: [
      "LinkedIn API has strict rate limits — respect them to avoid account restrictions",
      "Use the Marketing Developer Platform for advertising APIs",
      "Test with a LinkedIn test company page before production use",
      "LinkedIn messaging requires explicit provider approval and is unavailable until that access is granted",
    ],
    troubleshooting: [
      {
        problem: "App not verified",
        solution: "Ensure you are a super admin of the associated LinkedIn Company Page",
      },
      {
        problem: "Insufficient permissions",
        solution: "Request additional products/scopes in your app's Products tab on the Developer Portal",
      },
      {
        problem: "OAuth callback error",
        solution: "Verify the redirect URL in your app's Auth settings matches exactly, including https and trailing slashes",
      },
    ],
  },

  googleAds: {
    platform: "Google Ads",
    overview: "Connect your Google Ads account to manage search, display, and video campaigns directly via the Google Ads API.",
    requirements: [
      "A Google Ads account (Individual or Manager/MCC)",
      "A Google Cloud project with the Ads API enabled",
      "A verified Developer Token from the Google Ads API Center",
      "OAuth 2.0 Credentials (Client ID, Client Secret, and Refresh Token)",
    ],
    steps: [
      {
        title: "Create a Google Cloud Project",
        description: "Go to the Google Cloud Console and create a new project for your Ads integration.",
        link: { url: "https://console.cloud.google.com/projectcreate", text: "Create Google Cloud Project" },
      },
      {
        title: "Enable the Google Ads API",
        description: "In your Cloud Project, search for 'Google Ads API' in the Library and click 'Enable'.",
        action: "Search and Enable 'Google Ads API'",
      },
      {
        title: "Configure OAuth Consent Screen",
        description: "Set up your OAuth consent screen (Internal or External) and add the '../auth/google/callback' redirect URI.",
        note: "For production, your app may need to be verified by Google.",
      },
      {
        title: "Create OAuth 2.0 Credentials",
        description: "Go to APIs & Services → Credentials → Create Credentials → OAuth Client ID. Select 'Web application'.",
        code: "Authorized Redirect URI: https://your-domain.com/api/integrations/google-ads/callback",
      },
      {
        title: "Get a Developer Token",
        description: "Log in to your Google Ads Manager account, go to Tools & Settings → API Center, and request a Developer Token.",
        warning: "New Developer Tokens start with 'Test' access. You must apply for 'Basic' access to manage production accounts.",
        link: { url: "https://ads.google.com/aw/apicenter", text: "Google Ads API Center" },
      },
      {
        title: "Get Your Customer ID",
        description: "Your 10-digit Customer ID is found at the top right of your Google Ads dashboard (e.g., 123-456-7890).",
      },
      {
        title: "Generate a Refresh Token",
        description: `Use the internal Google OAuth flow to authorize ${BRAND_NAME} and obtain a permanent Refresh Token.`,
      },
    ],
    tips: [
      "Use a Manager Account (MCC) if you need to manage multiple client accounts with a single set of credentials",
      "Always use 'Basic' access for production environments to avoid rate limiting",
      "Test your settings with a Google Ads Test Account before launching production campaigns",
    ],
    troubleshooting: [
      {
        problem: "Developer Token not approved",
        solution: "Verification can take several days. Ensure your Google Cloud project is properly linked and billing is enabled.",
      },
      {
        problem: "Authentication failed (401)",
        solution: "Verify that your Client ID, Secret, and Refresh Token match exactly what is in the Cloud Console.",
      },
      {
        problem: "Permission denied (403)",
        solution: "Ensure the authorized user has 'Admin' access to the Google Ads account being managed.",
      },
    ],
  },
  email: {
    platform: "Email (Gmail & Resend)",
    overview: "Configure your email outreach channels. Connect Gmail via OAuth for personal/business accounts, and Resend for high-volume custom domain sending.",
    requirements: [
      "A Google/Gmail account for OAuth connection",
      "A custom domain for Resend integration",
      "Access to DNS settings for domain verification",
    ],
    steps: [
      {
        title: "Gmail Connection",
        description: "Click 'Connect Gmail' to authorize your account via Google OAuth. This allows sending and receiving emails directly.",
        action: "Click 'Connect Gmail'",
      },
      {
        title: "Add Custom Domain (Resend)",
        description: "Enter your domain (e.g., mail.yourdomain.com) and add the provided DNS records (MX, TXT, CNAME) to your domain provider.",
        action: "Add Domain in Resend section",
      },
      {
        title: "Verify DNS Records",
        description: "Once records are added, click 'Verify Domain'. Green checkmarks will appear when records are confirmed.",
      },
      {
        title: "Set Up Active Senders",
        description: "Add specific verified email addresses (e.g., hello@yourdomain.com) to the 'Active Senders' list to start sending campaigns.",
      },
    ],
    tips: [
      "Use Gmail for relationship-based outreach and Resend for large-scale cold campaigns",
      "Always verify your domain records to ensure maximum deliverability",
      "Start with a warm-up period for new domains to avoid spam filters",
    ],
    troubleshooting: [
      {
        problem: "Gmail Authorization failed",
        solution: "Ensure you are signing in with the correct account and have granted all requested permissions.",
      },
      {
        problem: "DNS Records not verifying",
        solution: "DNS propagation can take time. Wait 15-30 minutes and try again. Ensure no 'orange cloud' proxy is active if using Cloudflare.",
      },
    ],
  },
};

export default IntegrationDocs;
