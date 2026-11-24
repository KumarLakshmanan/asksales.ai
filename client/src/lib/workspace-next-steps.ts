import { readStringList } from "@/lib/workspace-profile";
import { moduleForDashboardPath, type PlatformModuleKey } from "@/lib/platform-access";

export interface OnboardingStatus {
  profile: { applicationUses?: unknown; preferredChannels?: unknown; setupGoal?: string; workspaceType?: string; companySize?: string };
  connectedChannels: string[];
  completedTasks: string[];
  connectionsAvailable?: boolean;
}
export interface WorkspaceNextStep { id: string; title: string; description: string; href: string; completed: boolean }
const useTasks: Record<string, Omit<WorkspaceNextStep, "completed">> = {
  customer_support: { id: "support", title: "Review your support workspace", description: "Review customer tickets, team ownership, and support activity.", href: "/dashboard/support" },
  sales_leads: { id: "leads", title: "Add your first prospects", description: "Build the prospect list for your first sales activity.", href: "/dashboard/leads" },
  content_social: { id: "content", title: "Create your first content", description: "Use your saved brand voice and visuals in a new draft.", href: "/dashboard/saved-templates" },
  marketing_campaigns: { id: "campaign", title: "Plan your first campaign", description: "Choose a channel, audience, and message before sending.", href: "/dashboard/outreach/create" },
  advertising: { id: "advertising", title: "Prepare your first ad campaign", description: "Prepare a campaign brief, audience, and budget for review before launch.", href: "/dashboard/ads/create" },
  personal_productivity: { id: "research", title: "Brief your first agent", description: "Describe the research, planning, or organizing work you need.", href: "/dashboard/conversations" },
};
const channelRoutes: Record<string, string> = {
  Email: "/dashboard/integrations/email", WhatsApp: "/dashboard/integrations/whatsapp",
  Instagram: "/dashboard/integrations/instagram", "Facebook / Messenger": "/dashboard/integrations/facebook",
  YouTube: "/dashboard/integrations/youtube", "Google Ads": "/dashboard/integrations/google-ads",
  "Meta Ads": "/dashboard/integrations/meta", "Website chat": "/dashboard/support-ai/embed",
};
export function workspaceNextSteps(status: OnboardingStatus, role: string | undefined, enabledModules?: PlatformModuleKey[]): WorkspaceNextStep[] {
  if (!status?.profile || typeof status.profile !== "object") return [];
  const complete = new Set(status.completedTasks || []);
  const connected = new Set(status.connectionsAvailable === false ? [] : status.connectedChannels || []);
  const tasks: WorkspaceNextStep[] = [];
  if (role === "owner") tasks.push({ id: "brand", title: "Review your brand toolkit", description: "Your brand details guide content created for this workspace.", href: "/dashboard/brand-toolkit", completed: complete.has("brand") });
  for (const channel of readStringList(status.profile.preferredChannels)) {
    const href = channelRoutes[channel];
    if (!href) continue;
    const verified = connected.has(channel);
    tasks.push({ id: `channel:${channel}`, title: status.connectionsAvailable === false ? `Check ${channel} connection` : `${verified ? "Review" : "Connect"} ${channel}`, description: verified ? "Connection confirmed for this workspace." : "Selected during setup. Open channel settings to check and connect your account.", href, completed: verified });
  }
  for (const use of readStringList(status.profile.applicationUses)) {
    const task = useTasks[use];
    if (task && !tasks.some(item => item.id === task.id)) tasks.push({ ...task, completed: complete.has(task.id) });
  }
  if (role === "owner" && ["agency", "business"].includes(status.profile.workspaceType || "") && status.profile.companySize && status.profile.companySize !== "1") tasks.push({ id: "team", title: "Invite your team", description: "Give staff access to this workspace with the right role.", href: "/dashboard/settings/team", completed: complete.has("team") });
  return tasks.filter(task => { const moduleKey = moduleForDashboardPath(task.href); return !moduleKey || enabledModules === undefined || enabledModules.includes(moduleKey); });
}
