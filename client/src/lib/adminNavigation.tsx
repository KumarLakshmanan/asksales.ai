import type { ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Calendar,
  CircleDollarSign,
  ClipboardList,
  Coins,
  CreditCard,
  Database,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  Image,
  IndianRupee,
  Instagram,
  Layers,
  ListTodo,
  Mail,
  MessageCircle,
  MessageSquare,
  Palette,
  Plug,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  Tag,
  Target,
  TrendingUp,
  Users,
  Video,
  Webhook,
  Workflow,
} from "lucide-react";

export interface AdminNavItem {
  label: string;
  path: string;
  icon: ReactNode;
  exact?: boolean;
  superAdminOnly?: boolean;
  keywords?: string[];
}

export interface AdminNavGroup {
  label: string;
  children: AdminNavItem[];
}

export interface AdminNavSection {
  label: string;
  icon: ReactNode;
  children: AdminNavItem[];
  groups?: AdminNavGroup[];
}

const path = (area: string, child?: string) =>
  `/admin/dashboard/${area}${child ? `/${child}` : ""}`;

export const adminMainNavItems: AdminNavItem[] = [
  { label: "Dashboard", path: path("home"), icon: <BarChart3 size={19} /> },
];

export const adminNavSections: AdminNavSection[] = [
  {
    label: "Accounts",
    icon: <Users size={19} />,
    children: [
      { label: "Users", path: path("users"), icon: <Users size={18} />, keywords: ["customers", "workspaces", "tenants"] },
      { label: "Administrators", path: path("admins"), icon: <Shield size={18} />, keywords: ["admins", "roles", "staff"] },
    ],
  },
  {
    label: "Growth",
    icon: <Target size={19} />,
    children: [
      { label: "Campaigns", path: path("campaigns"), icon: <BarChart3 size={18} /> },
    ],
    groups: [
      {
        label: "Lead operations",
        children: [
          { label: "Leads", path: path("leads"), icon: <Target size={17} /> },
          { label: "Master Database", path: path("master-database"), icon: <Database size={17} />, keywords: ["all leads", "lead database"] },
          { label: "Business Categories", path: path("business-categories"), icon: <Layers size={17} /> },
          { label: "Leadflow", path: path("leadflow"), icon: <Workflow size={17} />, keywords: ["workflow", "automation"] },
        ],
      },
    ],
  },
  {
    label: "Content & Outreach",
    icon: <FileText size={19} />,
    children: [],
    groups: [
      {
        label: "Content & templates",
        children: [
          { label: "Content Templates", path: path("content-templates"), icon: <FileText size={17} /> },
          { label: "Email Templates", path: path("email-templates"), icon: <Mail size={17} /> },
          { label: "DM Templates", path: path("dm-templates"), icon: <MessageCircle size={17} /> },
          { label: "Brand Toolkits", path: path("brand-toolkits"), icon: <Palette size={17} /> },
          { label: "Content Calendar", path: path("content-calendar"), icon: <Calendar size={17} /> },
          { label: "Proposal Templates", path: path("proposal-templates"), icon: <FileText size={17} /> },
        ],
      },
      {
        label: "Outreach activity",
        children: [
          { label: "Email", path: path("outreach", "email"), icon: <Mail size={17} /> },
          { label: "SMS", path: path("outreach", "sms"), icon: <MessageSquare size={17} /> },
          { label: "WhatsApp", path: path("outreach", "whatsapp"), icon: <MessageCircle size={17} /> },
          { label: "Instagram DMs", path: path("outreach", "instagram"), icon: <Instagram size={17} /> },
        ],
      },
    ],
  },
  {
    label: "Platform",
    icon: <Plug size={19} />,
    children: [
      { label: "Integrations", path: path("integrations"), icon: <Plug size={18} />, superAdminOnly: true, keywords: ["providers", "credentials", "API keys"] },
      { label: "AI model catalog", path: path("integrations", "llm/models"), icon: <Server size={18} />, superAdminOnly: true, keywords: ["assistant models", "reply model", "model names"] },
    ],
    groups: [
      {
        label: "Usage & costs",
        children: [
          { label: "Usage Overview", path: path("usage"), icon: <Activity size={17} />, exact: true },
          { label: "LLM Usage", path: path("usage", "llms"), icon: <Server size={17} />, keywords: ["AI usage", "tokens"] },
          { label: "Platform Analytics", path: path("usage", "platform"), icon: <BarChart3 size={17} /> },
        ],
      },
      {
        label: "LLM provider reports",
        children: [
          { label: "OpenAI Usage", path: path("usage", "openai"), icon: <Server size={17} /> },
          { label: "Gemini LLM Usage", path: path("usage", "gemini"), icon: <Server size={17} /> },
          { label: "OpenRouter Usage", path: path("usage", "openrouter"), icon: <Server size={17} /> },
        ],
      },
      {
        label: "Service usage",
        children: [
          { label: "Gemini Image Usage", path: path("usage", "gemini-image"), icon: <Image size={17} /> },
          { label: "Gemini Video Usage", path: path("usage", "gemini-video"), icon: <Video size={17} /> },
          { label: "Embedding Usage", path: path("usage", "embeddings"), icon: <Database size={17} />, keywords: ["vector", "RAG"] },
          { label: "Apify Usage", path: path("usage", "apify"), icon: <Server size={17} /> },
          { label: "ZeroBounce Usage", path: path("usage", "zerobounce"), icon: <ShieldCheck size={17} /> },
        ],
      },
      {
        label: "Billing & credits",
        children: [
          { label: "Business plans & credits", path: path("settings", "subscriptions"), icon: <CreditCard size={17} />, superAdminOnly: true, keywords: ["subscriptions", "organizations", "limits", "allowances", "Razorpay", "shared wallet"] },
          { label: "Credit & API Pricing", path: path("credit-pricing"), icon: <Coins size={17} />, superAdminOnly: true, keywords: ["recharge", "model costs", "margins"] },
          { label: "WhatsApp billing", path: path("whatsapp-billing"), icon: <MessageSquare size={17} />, superAdminOnly: true, keywords: ["Meta", "credit line", "rate card", "WABA", "message charges", "reconciliation"] },
          { label: "Pricing History", path: path("pricing-history"), icon: <History size={17} />, superAdminOnly: true },
          { label: "Account wallets", path: path("wallets"), icon: <CreditCard size={17} /> },
          { label: "Credit Events", path: path("credit-events"), icon: <Activity size={17} /> },
          { label: "Credit Analytics", path: path("credit-analytics"), icon: <IndianRupee size={17} /> },
          { label: "Revenue", path: path("revenue"), icon: <TrendingUp size={17} /> },
        ],
      },
      {
        label: "Storage",
        children: [
          { label: "Storage Overview", path: path("storage"), icon: <HardDrive size={17} /> },
          { label: "Plans", path: path("storage", "plans"), icon: <Tag size={17} />, superAdminOnly: true },
          { label: "Storage Pricing", path: path("storage", "pricing"), icon: <CircleDollarSign size={17} />, superAdminOnly: true },
          { label: "User Files", path: path("storage", "users"), icon: <FolderOpen size={17} />, superAdminOnly: true },
        ],
      },
    ],
  },
  {
    label: "Configuration & Support",
    icon: <ShieldCheck size={19} />,
    children: [
      { label: "Platform Access", path: path("settings", "platform-access"), icon: <Plug size={18} />, superAdminOnly: true, keywords: ["module availability", "maintenance"] },
      { label: "Policies & Requests", path: path("policies"), icon: <FileText size={18} />, keywords: ["account deletion", "legal"] },
      { label: "Support Playbooks", path: path("support-playbooks"), icon: <Workflow size={18} /> },
      { label: "Support Agent Defaults", path: path("support-agents"), icon: <ShieldCheck size={18} />, keywords: ["prompts", "safety", "handoff", "escalation"] },
    ],
  },
  {
    label: "Operations",
    icon: <Activity size={19} />,
    children: [
      { label: "Queues", path: path("queues"), icon: <ListTodo size={18} />, superAdminOnly: true, keywords: ["jobs", "workers"] },
      { label: "System Logs", path: path("system-logs"), icon: <ScrollText size={18} /> },
      { label: "Webhook Logs", path: path("webhook-logs"), icon: <Webhook size={18} /> },
      { label: "Audit Logs", path: path("audit-logs"), icon: <ClipboardList size={18} />, superAdminOnly: true },
    ],
  },
];

export interface AdminSearchEntry {
  label: string;
  path: string;
  section: string;
  keywords?: string[];
  superAdminOnly?: boolean;
  icon: ReactNode;
}

const flattenItems = (items: AdminNavItem[], section: string): AdminSearchEntry[] =>
  items.map((item) => ({ ...item, section }));

const regularSearchEntries = [
  ...flattenItems(adminMainNavItems, "Overview"),
  ...adminNavSections.flatMap((section) => [
    ...flattenItems(section.children, section.label),
    ...(section.groups || []).flatMap((group) => flattenItems(group.children, `${section.label} · ${group.label}`)),
  ]),
];

const integrationSearchEntries: AdminSearchEntry[] = [
  ["LLM Providers", "llm", ["OpenAI", "Gemini Developer API", "Vertex AI", "OpenRouter", "Custom AI", "models", "model choice", "credential status", "validation", "test connection", "chat", "generation"]],
  ["Intent Classifier", "intent-classifier", ["OpenRouter", "OpenAI", "Gemini", "Vertex AI", "Custom AI", "priority", "priority order", "fallback", "fallback order", "validation", "test connection"]],
  ["Image Generation Providers", "gemini-image", ["Gemini", "Vertex AI", "image models", "model choice", "validation", "test generation"]],
  ["Video Generation Providers", "gemini-video", ["Gemini", "Vertex AI", "Veo", "video models", "model choice", "validation", "test generation"]],
  ["Embedding Providers", "embeddings", ["OpenAI Embedding", "Gemini Embedding", "OpenRouter Embedding", "chunk size", "chunk settings", "overlap", "validation", "RAG"]],
  ["Meta App", "meta_app", ["Facebook", "Instagram", "Ads OAuth", "app id", "app secret", "webhook"]],
  ["Email SMTP", "smtp", ["OTP", "password reset", "notifications"]],
  ["Resend", "resend", ["transactional email", "outreach"]],
  ["Gmail OAuth", "gmail_oauth", ["Gmail API", "Google OAuth"]],
  ["Apify", "apify", ["scraping", "lead generation"]],
  ["ZeroBounce", "zerobounce", ["email validation", "deliverability"]],
  ["Razorpay", "razorpay", ["payments", "wallet recharge"]],
].map(([label, child, keywords]) => ({
  label: `${label} integration`,
  path: path("integrations", child as string),
  section: "Platform · Integrations",
  keywords: (keywords as string[]),
  superAdminOnly: true,
  icon: <Plug size={16} />,
}));

const pricingSearchEntries: AdminSearchEntry[] = [
  ["Recharge Rules", "recharge-rules", ["credits per unit", "wallet"]],
  ["API Model Pricing", "api-pricing", ["provider cost", "LLM costs"]],
  ["LLM Margins", "llm-pricing", ["OpenAI", "OpenRouter", "Google Gemini"]],
  ["Image Generation Margins", "image-pricing", ["image cost"]],
  ["Video Generation Margins", "video-pricing", ["video cost"]],
  ["Other Provider Pricing", "other-api-pricing", ["Apify", "ZeroBounce"]],
  ["Platform Pricing Events", "platform-pricing-events", ["platform events"]],
].map(([label, anchor, keywords]) => ({
  label: String(label),
  path: `${path("credit-pricing")}#${String(anchor)}`,
  section: "Platform · Billing & credits",
  keywords: keywords as string[],
  superAdminOnly: true,
  icon: <Coins size={16} />,
}));

export const adminSearchEntries: AdminSearchEntry[] = [
  ...regularSearchEntries,
  ...integrationSearchEntries,
  ...pricingSearchEntries,
];
