import React from "react";
import {
  TicketCheck,
  Bot,
  Settings,
  User,
  LayoutDashboard,
  BarChart3,
  BookOpen,
  BellRing,
  FileCheck2,
  Images,
  Workflow,
} from "lucide-react";

export interface NavItem {
  label: string;
  path: string;
  icon?: React.ReactNode;
}

export interface NavSection {
  section: string;
  label: string;
  icon?: React.ReactNode;
  activePath: string;
  activeExtraPaths?: string[];
  collapsedPath: string;
  collapsedIcon: React.ReactNode;
  children: NavItem[];
}

export const supportNavSections: NavSection[] = [
  {
    section: "dashboard",
    label: "Overview",
    icon: <LayoutDashboard className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/dashboard",
    collapsedPath: "/support/dashboard",
    collapsedIcon: <LayoutDashboard className="w-5 h-5" />,
    children: [],
  },
  {
    section: "tickets",
    label: "Tickets",
    icon: <TicketCheck className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/tickets",
    collapsedPath: "/support/tickets",
    collapsedIcon: <TicketCheck className="w-5 h-5" />,
    activeExtraPaths: ["/support/tickets/pipeline"],
    children: [
      { label: "Queue", path: "/support/tickets", icon: <TicketCheck className="w-3.5 h-3.5" /> },
      { label: "Pipeline", path: "/support/tickets/pipeline", icon: <Workflow className="w-3.5 h-3.5" /> },
    ],
  },
  {
    section: "notifications",
    label: "Notifications",
    icon: <BellRing className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/notifications",
    collapsedPath: "/support/notifications",
    collapsedIcon: <BellRing className="w-5 h-5" />,
    children: [],
  },
  {
    section: "proposal-reviews",
    label: "Proposal reviews",
    icon: <FileCheck2 className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/proposal-reviews",
    collapsedPath: "/support/proposal-reviews",
    collapsedIcon: <FileCheck2 className="w-5 h-5" />,
    children: [],
  },
  {
    section: "support-ai",
    label: "Support AI",
    icon: <Bot className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/chat",
    collapsedPath: "/support/chat",
    collapsedIcon: <Bot className="w-5 h-5" />,
    children: [],
  },
  {
    section: "knowledge-base",
    label: "Knowledge Base",
    icon: <BookOpen className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/knowledge-base",
    collapsedPath: "/support/knowledge-base",
    collapsedIcon: <BookOpen className="w-5 h-5" />,
    children: [],
  },
  {
    section: "media-library",
    label: "Media Library",
    icon: <Images className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/media",
    collapsedPath: "/support/media",
    collapsedIcon: <Images className="w-5 h-5" />,
    children: [],
  },
  {
    section: "playbooks",
    label: "Playbooks",
    icon: <Workflow className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/playbooks",
    collapsedPath: "/support/playbooks",
    collapsedIcon: <Workflow className="w-5 h-5" />,
    children: [],
  },
  {
    section: "analytics",
    label: "Performance",
    icon: <BarChart3 className="w-4 h-4 flex-shrink-0" />,
    activePath: "/support/analytics",
    collapsedPath: "/support/analytics",
    collapsedIcon: <BarChart3 className="w-5 h-5" />,
    children: [],
  },
];

export const supportBottomNavItems: NavItem[] = [
  { label: "Profile", path: "/support/profile", icon: <User className="w-4 h-4 flex-shrink-0" /> },
  { label: "Settings", path: "/support/settings", icon: <Settings className="w-4 h-4 flex-shrink-0" /> },
];
