"use client";

import { Twitter } from "lucide-react";
import DrillDownPage, { type DrillDownPageConfig } from "@/components/outreach/DrillDownPage";

const config: DrillDownPageConfig = {
  channel: "twitter",
  icon: Twitter,
  displayName: "Twitter / X",
  iconBgClass: "bg-sky-500/10",
  iconTextClass: "text-sky-600 dark:text-sky-400",
  selectedBorderClass: "border-sky-400/30",
  selectedBgClass: "bg-sky-500/5",
  selectedRingClass: "ring-1 ring-sky-500/10",
  integrationName: "Twitter / X",
  integrationDescription: "Connect your Twitter account to manage DM conversations and engage with your leads.",
  iconColorClass: "text-sky-500",
  features: [
    "Send and receive direct messages",
    "Track conversation history",
    "Manage leads via Twitter DMs",
    "Use templates for quick replies",
    "AI-powered message generation",
  ],
  integrationPath: "/dashboard/integrations/twitter",
  oauthEndpoint: "/api/twitter/oauth/status",
  messagesEndpoint: (convId) => `/api/outreach-conversations/twitter/${convId}/messages`,
  leadHandleField: "leadTwitter",
  formatLeadSubtext: (lead) => lead.handle ? `@${lead.handle}` : lead.company || "No handle",
  formatConversationSubtext: (_conv, lead) => lead?.handle ? `@${lead.handle}` : "Twitter DM",
  formatDraftPrompt: (leadName) => `Generate a professional Twitter DM for lead: ${leadName}`,
  formatSentToast: () => "Twitter DM sent successfully",
  formatEmptyStateTitle: () => "Twitter Outreach",
  formatEmptyStateDescription: () => "Select a lead from the sidebar to view or send Twitter DMs.",
  formatNewDraftTitle: () => "New Twitter DM",
  formatNewDraftDescription: (leadName) => `Compose your message below and send to ${leadName}.`,
};

export default function TwitterOutreachPage() {
  return <DrillDownPage config={config} />;
}
