import React from "react";
import { integrationDefinitions, integrationPath } from "./integrations";
import { moduleForDashboardPath, moduleForNavigationSection, type PlatformModuleKey } from "./platform-access";
import type { BusinessProfileSummary } from "@/hooks/use-business-profiles";
import {
  MessageSquare,
  Users,
  FileText,
  Images,
  Target,
  Megaphone,
  Kanban,
  Bell,
  Headphones,
  BarChart3,
  ListChecks,
  Plug,
  Settings,
  CreditCard,
  HardDrive,
  Plus,
  Eye,
  LayoutTemplate,
  User,
  Send,
  Sliders,
  BookOpen,
  TicketCheck,
  UserPlus,
  Palette,
  CalendarDays,
  Bot,
  Code,
  Sparkles,
  Workflow,
  Upload,
  SearchCheck,
  ScanSearch,
  Inbox,
} from "lucide-react";

export interface NavItem {
  label: string;
  /** Previous names remain available to the page finder. */
  aliases?: string[];
  module?: PlatformModuleKey;
  roles?: readonly NonNullable<BusinessProfileSummary['role']>[];
  preserveQueryParams?: string[];
  path: string;
  icon?: React.ReactNode;
  children?: NavItem[];
}

export interface NavSection {
  section: string;
  label: string;
  aliases?: string[];
  icon?: React.ReactNode;
  activePath: string;
  activeExtraPaths?: string[];
  collapsedPath: string;
  collapsedIcon: React.ReactNode;
  children: NavItem[];
  presentation?: "group";
}

export const navSections: NavSection[] = [
  {
    section: "campaigns",
    label: "Campaign History",
    aliases: ["Campaigns", "Conversational campaigns"],
    icon: <MessageSquare className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/chat",
    activeExtraPaths: ["/dashboard/chats", "/dashboard/conversations"],
    collapsedPath: "/dashboard/chats",
    collapsedIcon: <MessageSquare className="w-5 h-5" />,
    children: [
      { label: "New Campaign", path: "/dashboard/conversations", icon: <Plus className="w-4 h-4 flex-shrink-0" /> },
      { label: "All Campaigns", aliases: ["View All", "View all campaigns", "Campaign History"], path: "/dashboard/chats", icon: <Eye className="w-4 h-4 flex-shrink-0" /> },
    ],
  },
  {
    section: "lead-agent",
    label: "Lead Generation",
    icon: <Users className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/leads",
    activeExtraPaths: ["/dashboard/enrichment"],
    collapsedPath: "/dashboard/leads",
    collapsedIcon: <Users className="w-5 h-5" />,
    children: [
      { label: "Leads", path: "/dashboard/leads", icon: <Users className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Enrichment", path: "/dashboard/enrichment", icon: <Sparkles className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "content-agent",
    label: "Content Creator",
    icon: <FileText className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/saved-templates",
    activeExtraPaths: ["/dashboard/brand-toolkit", "/dashboard/content-calendar"],
    collapsedPath: "/dashboard/saved-templates",
    collapsedIcon: <FileText className="w-5 h-5" />,
    children: [
      { label: "Content library", aliases: ["Templates", "Saved templates"], path: "/dashboard/saved-templates", icon: <LayoutTemplate className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Brand Toolkit", path: "/dashboard/brand-toolkit", icon: <Palette className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Calendar", path: "/dashboard/content-calendar", icon: <CalendarDays className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "performance-marketing",
    label: "Marketing",
    aliases: ["Performance Marketing"],
    icon: <Target className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/ads",
    activeExtraPaths: ["/dashboard/ads-campaigns", "/dashboard/ads-analytics", "/dashboard/marketing"],
    collapsedPath: "/dashboard/ads",
    collapsedIcon: <Target className="w-5 h-5" />,
    children: [
      { label: "Paid Ads", path: "/dashboard/ads", icon: <Megaphone className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Social Insights", path: "/dashboard/marketing/analytics", icon: <ScanSearch className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "ai-visibility",
    label: "AI Visibility",
    icon: <SearchCheck className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/ai-visibility",
    collapsedPath: "/dashboard/ai-visibility",
    collapsedIcon: <SearchCheck className="w-5 h-5" />,
    children: [],
  },
  {
    section: "outreach-agent",
    label: "Outreach",
    icon: <Send className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/outreach",
    collapsedPath: "/dashboard/outreach/inbox",
    collapsedIcon: <Send className="w-5 h-5" />,
    children: [
      { label: "Inbox", path: "/dashboard/outreach/inbox", icon: <Inbox className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "New outreach", path: "/dashboard/outreach/create", icon: <Plus className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Message tracking", path: "/dashboard/outreach/tracking", icon: <ListChecks className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Follow-ups", path: "/dashboard/outreach/follow-ups", icon: <Workflow className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Reports", path: "/dashboard/outreach/reports", icon: <BarChart3 className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "crm",
    label: "CRM",
    icon: <Users className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/crm",
    collapsedPath: "/dashboard/crm",
    collapsedIcon: <Users className="w-5 h-5" />,
    children: [
      { label: "Contacts", path: "/dashboard/crm/contacts", icon: <UserPlus className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Pipeline", path: "/dashboard/crm/pipeline", icon: <Kanban className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "My Work", path: "/dashboard/crm/work", icon: <CalendarDays className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Reports", path: "/dashboard/crm/reports", icon: <BarChart3 className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Reminders", path: "/dashboard/crm/reminders", icon: <Bell className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Alerts", path: "/dashboard/crm/alerts", icon: <Target className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Automations", path: "/dashboard/crm/automations", icon: <Workflow className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Import Contacts", path: "/dashboard/crm/import", icon: <Upload className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Configuration", path: "/dashboard/crm/configuration", roles: ["owner", "billing_admin", "member"], icon: <Settings className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "support",
    label: "Support",
    icon: <Headphones className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/support",
    collapsedPath: "/dashboard/support",
    collapsedIcon: <Headphones className="w-5 h-5" />,
    children: [
      { label: "Tickets", path: "/dashboard/support", icon: <TicketCheck className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Teams", path: "/dashboard/support/teams", roles: ["owner"], icon: <Users className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Notifications", path: "/dashboard/support/notifications", roles: ["owner"], icon: <Bell className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Pipeline", path: "/dashboard/support/pipeline", icon: <Kanban className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Analytics", path: "/dashboard/support/analytics", icon: <BarChart3 className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "support-ai",
    label: "Support AI",
    icon: <Bot className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/support-ai",
    collapsedPath: "/dashboard/support-ai/chat",
    collapsedIcon: <Bot className="w-5 h-5" />,
    children: [
      { label: "Chat", path: "/dashboard/support-ai/chat", icon: <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Embed & Integrate", path: "/dashboard/support-ai/embed", icon: <Code className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Reports", path: "/dashboard/support-ai/reports", icon: <BarChart3 className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Widget settings", path: "/dashboard/support-ai/widget-settings", module: "support_ai", roles: ["owner", "billing_admin", "member"], preserveQueryParams: ["team"], icon: <Settings className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "proposals",
    label: "Proposals",
    icon: <FileText className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/proposals",
    collapsedPath: "/dashboard/proposals",
    collapsedIcon: <FileText className="w-5 h-5" />,
    children: [
      { label: "All Proposals", path: "/dashboard/proposals", icon: <FileText className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Products & Services", path: "/dashboard/proposals/catalog", icon: <FileText className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Templates", path: "/dashboard/proposals/templates", icon: <LayoutTemplate className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Analytics", path: "/dashboard/proposals/analytics", icon: <BarChart3 className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Proposal settings", path: "/dashboard/proposals/settings", roles: ["owner", "billing_admin", "member"], icon: <Settings className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "knowledge-base",
    label: "Knowledge Base",
    icon: <BookOpen className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/knowledge-base",
    activeExtraPaths: ["/dashboard/settings/knowledge-base"],
    collapsedPath: "/dashboard/knowledge-base",
    collapsedIcon: <BookOpen className="w-5 h-5" />,
    children: [
      { label: "Knowledge", path: "/dashboard/knowledge-base", icon: <BookOpen className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Media galleries", path: "/dashboard/knowledge-base/media", icon: <Images className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Documents", path: "/dashboard/knowledge-base/documents", icon: <FileText className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
  {
    section: "integrations",
    label: "Integrations",
    presentation: "group",
    icon: <Plug className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/integrations",
    collapsedPath: "/dashboard/integrations",
    collapsedIcon: <Plug className="w-5 h-5" />,
    children: [
      ...integrationDefinitions.map(({ id, name, icon: Icon }) => ({ label: name, path: integrationPath(id), icon: <Icon className="h-4 w-4 shrink-0" /> })),
    ],
  },
  {
    section: "settings",
    label: "Settings",
    icon: <Settings className="w-4 h-4 flex-shrink-0" />,
    activePath: "/dashboard/settings",
    collapsedPath: "/dashboard/settings",
    collapsedIcon: <Settings className="w-5 h-5" />,
    children: [
      { label: "Account settings", aliases: ["Profile & Security"], path: "/dashboard/settings", icon: <User className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Workspace config", aliases: ["Workspace configuration", "Workspace settings"], path: "/dashboard/settings/workspace", roles: ["owner", "billing_admin", "member"], icon: <Settings className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Staff", path: "/dashboard/settings/team", roles: ["owner", "billing_admin", "member"], icon: <Users className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Assistants", aliases: ["Outreach Settings", "Outreach assistants"], path: "/dashboard/settings/outreach", module: "support_ai", roles: ["owner", "billing_admin", "member"], icon: <Send className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Ad Settings", path: "/dashboard/settings/ads", icon: <Megaphone className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Lead Settings", path: "/dashboard/settings/leads", icon: <Target className="w-3.5 h-3.5 flex-shrink-0" /> },
      { label: "Preferences", path: "/dashboard/settings/preferences", icon: <Sliders className="w-3.5 h-3.5 flex-shrink-0" /> },
    ],
  },
];

/** Shared sidebar/finder visibility; linked pages and APIs still enforce access. */
export function availableNavigationSections(enabledModules: readonly PlatformModuleKey[], workspaceRole?: BusinessProfileSummary['role']): NavSection[] {
  const modules = new Set(enabledModules);
  return navSections.filter(section => {
    const moduleKey = moduleForNavigationSection(section.section);
    return !moduleKey || modules.has(moduleKey);
  }).map(section => ({
    ...section,
    children: section.children.filter(item => {
      const moduleKey = item.module ?? moduleForDashboardPath(item.path);
      return (!moduleKey || modules.has(moduleKey)) && (!item.roles || Boolean(workspaceRole && item.roles.includes(workspaceRole)));
    }),
  }));
}

/** Retain only explicit context parameters, such as a widget's selected team. */
export function navigationItemHref(item: NavItem, query: { get: (name: string) => string | null }): string {
  const params = new URLSearchParams();
  for (const name of item.preserveQueryParams ?? []) {
    const value = query.get(name);
    if (value !== null) params.set(name, value);
  }
  return params.size ? `${item.path}?${params}` : item.path;
}

/** Choose one leaf even when an index is also a parent of other destinations. */
export function navigationItemActive(pathname: string, path: string, sections: NavSection[] = navSections): boolean {
  if (pathname === path) return true;
  if (!pathname.startsWith(`${path}/`)) return false;
  // Collection indexes own detail IDs, not unknown/temporarily hidden sibling pages.
  const indexes = ['/dashboard/support', '/dashboard/settings', '/dashboard/integrations', '/dashboard/proposals', '/dashboard/crm', '/dashboard/marketing', '/dashboard/knowledge-base'];
  if (indexes.includes(path) && !/^\d+$/.test(pathname.slice(path.length + 1).split('/')[0])) return false;
  const descendants = (items: NavItem[]): NavItem[] => items.flatMap(item => [item, ...descendants(item.children ?? [])]);
  return !sections.flatMap(section => descendants(section.children)).some(item =>
    item.path.startsWith(`${path}/`) && (pathname === item.path || pathname.startsWith(`${item.path}/`)));
}

/** Pick one workspace, including legacy routes, without prefix collisions. */
export function activeNavigationSection(pathname: string, sections: NavSection[] = navSections): NavSection | undefined {
  let active: NavSection | undefined;
  let matchedLength = -1;
  for (const section of sections) {
    for (const path of [section.activePath, ...(section.activeExtraPaths ?? [])]) {
      if ((pathname === path || pathname.startsWith(`${path}/`)) && path.length > matchedLength) {
        active = section;
        matchedLength = path.length;
      }
    }
  }
  return active;
}

export const bottomNavItems: NavItem[] = [
  { label: "Documentation", aliases: ["Help", "User guide", "How it works"], path: "/documentation", icon: <BookOpen className="w-4 h-4 flex-shrink-0" /> },
  { label: "Insights", path: "/dashboard/insights", icon: <BarChart3 className="w-4 h-4 flex-shrink-0" /> },
  { label: "Billing", path: "/dashboard/billing", icon: <CreditCard className="w-4 h-4 flex-shrink-0" /> },
  { label: "Storage", path: "/dashboard/storage", icon: <HardDrive className="w-4 h-4 flex-shrink-0" /> },
];
