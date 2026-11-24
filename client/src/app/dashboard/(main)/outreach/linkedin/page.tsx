"use client";

import { Linkedin } from "lucide-react";
import DrillDownPage, { type DrillDownPageConfig } from "@/components/outreach/DrillDownPage";

const config: DrillDownPageConfig = {
  channel: "linkedin",
  icon: Linkedin,
  displayName: "LinkedIn",
  iconBgClass: "bg-blue-700/10",
  iconTextClass: "text-blue-700 dark:text-blue-400",
  selectedBorderClass: "border-blue-600/30",
  selectedBgClass: "bg-blue-700/5",
  selectedRingClass: "ring-1 ring-blue-700/10",
  integrationName: "LinkedIn",
  integrationDescription: "Connect your LinkedIn account to manage message conversations and engage with your professional leads.",
  iconColorClass: "text-blue-700",
  features: [
    "Send and receive LinkedIn messages",
    "Track conversation history",
    "Manage professional leads",
    "Use templates for quick replies",
    "AI-powered message generation",
  ],
  integrationPath: "/dashboard/integrations/linkedin",
  oauthEndpoint: "/api/linkedin/oauth/status",
  messagesEndpoint: (convId) => `/api/outreach-conversations/linkedin/${convId}/messages`,
  leadHandleField: "leadLinkedin",
  formatLeadSubtext: (lead) => lead.company || lead.handle || "No profile",
  formatConversationSubtext: (_conv, lead) => lead?.handle || "LinkedIn Message",
  formatDraftPrompt: (leadName) => `Generate a professional LinkedIn message for lead: ${leadName}`,
  formatSentToast: () => "LinkedIn message sent successfully",
  formatEmptyStateTitle: () => "LinkedIn Outreach",
  formatEmptyStateDescription: () => "Select a lead from the sidebar to view or send LinkedIn messages.",
  formatNewDraftTitle: () => "New LinkedIn Message",
  formatNewDraftDescription: (leadName) => `Compose your message below and send to ${leadName}.`,
};

export default function LinkedInOutreachPage() {
  return <DrillDownPage config={config} />;
}
