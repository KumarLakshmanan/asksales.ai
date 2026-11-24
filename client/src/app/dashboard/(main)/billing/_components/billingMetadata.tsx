import {
  BarChart2,
  BookOpen,
  Bot,
  Eye,
  Building,
  FileText,
  Globe,
  ImageIcon,
  Mail,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Send,
  Shuffle,
  Sparkles,
  Target,
  UserCheck,
  Users,
  Wand2,
  Wrench,
} from "lucide-react";

export interface BillingReferenceMeta {
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

export interface BillingProviderMeta {
  desc: string; dot: string; bg: string; bgColor: string; chartColor: string;
  label: string;
  icon: React.ReactNode;
  color: string;
}

export const BILLING_REFERENCE_META: Record<string, BillingReferenceMeta> = {
  chat_thread:    { label: "Chat / AI Conversations", icon: <MessageSquare className="h-4 w-4" />, color: "text-blue-600 dark:text-blue-400",       bgColor: "bg-blue-500" },
  content:        { label: "Content Generation",      icon: <FileText className="h-4 w-4" />,      color: "text-violet-600 dark:text-violet-400",   bgColor: "bg-violet-500" },
  lead_gen:       { label: "Lead Generation",         icon: <Target className="h-4 w-4" />,        color: "text-emerald-600 dark:text-emerald-400", bgColor: "bg-emerald-500" },
  outreach:       { label: "Outreach",                icon: <Send className="h-4 w-4" />,          color: "text-green-600 dark:text-green-400",     bgColor: "bg-green-500" },
  campaign:       { label: "Campaigns",               icon: <Megaphone className="h-4 w-4" />,     color: "text-orange-600 dark:text-orange-400",   bgColor: "bg-orange-500" },
  analytics:      { label: "Analytics",               icon: <BarChart2 className="h-4 w-4" />,     color: "text-pink-600 dark:text-pink-400",       bgColor: "bg-pink-500" },
  apify_run:      { label: "Web Scraping",            icon: <Globe className="h-4 w-4" />,         color: "text-yellow-700 dark:text-yellow-400",   bgColor: "bg-yellow-500" },
  knowledge_base: { label: "Knowledge Base",          icon: <BookOpen className="h-4 w-4" />,      color: "text-cyan-700 dark:text-cyan-400",       bgColor: "bg-cyan-500" },
  icp:            { label: "ICP Generation",          icon: <UserCheck className="h-4 w-4" />,     color: "text-indigo-600 dark:text-indigo-400",   bgColor: "bg-indigo-500" },
  sent_message:   { label: "Sent Messages",           icon: <Mail className="h-4 w-4" />,          color: "text-teal-700 dark:text-teal-400",       bgColor: "bg-teal-500" },
  content_asset:  { label: "Content Assets",          icon: <FileText className="h-4 w-4" />,      color: "text-rose-600 dark:text-rose-400",       bgColor: "bg-rose-500" },
  lead:           { label: "Lead Operations",         icon: <Target className="h-4 w-4" />,        color: "text-lime-700 dark:text-lime-400",       bgColor: "bg-lime-500" },
  media_generation:          { label: "Image & video generation", icon: <ImageIcon className="h-4 w-4" />, color: "text-fuchsia-600 dark:text-fuchsia-400", bgColor: "bg-fuchsia-500" },
  crm_contact:               { label: "CRM contacts",            icon: <Users className="h-4 w-4" />,     color: "text-sky-700 dark:text-sky-400",         bgColor: "bg-sky-500" },
  outreach_message:          { label: "Outreach messages",       icon: <Send className="h-4 w-4" />,      color: "text-green-600 dark:text-green-400",     bgColor: "bg-green-500" },
  ai_visibility_audit:       { label: "AI visibility audits",    icon: <Eye className="h-4 w-4" />,       color: "text-pink-600 dark:text-pink-400",       bgColor: "bg-pink-500" },
  ai_visibility_audit_usage: { label: "AI visibility audits",    icon: <Eye className="h-4 w-4" />,       color: "text-pink-600 dark:text-pink-400",       bgColor: "bg-pink-500" },
  whatsapp_outreach:              { label: "WhatsApp messages", icon: <MessageCircle className="h-4 w-4" />, color: "text-green-700 dark:text-green-400", bgColor: "bg-green-600" },
  whatsapp_message_charge:        { label: "WhatsApp messages", icon: <MessageCircle className="h-4 w-4" />, color: "text-green-700 dark:text-green-400", bgColor: "bg-green-600" },
  whatsapp_message_charge_topup:  { label: "WhatsApp messages", icon: <MessageCircle className="h-4 w-4" />, color: "text-green-700 dark:text-green-400", bgColor: "bg-green-600" },
  other:          { label: "Other",                   icon: <Wrench className="h-4 w-4" />,        color: "text-muted-foreground",                  bgColor: "bg-slate-500" },
};

export const BILLING_PROVIDER_META: Record<string, BillingProviderMeta> = {
  openai:       { desc: "GPT models for content & AI", dot: "bg-green-500", bgColor: "bg-green-500", bg: "bg-green-50 dark:bg-green-900/20", chartColor: "#22c55e", label: "OpenAI",       icon: <Bot className="h-3.5 w-3.5" />,      color: "text-green-600 dark:text-green-400" },
  openrouter:   { desc: "Multi-model AI routing", dot: "bg-indigo-500", bgColor: "bg-indigo-500", bg: "bg-indigo-50 dark:bg-indigo-900/20", chartColor: "#6366f1", label: "OpenRouter",   icon: <Shuffle className="h-3.5 w-3.5" />,  color: "text-indigo-600 dark:text-indigo-400" },
  apify:        { desc: "Web scraping & data extraction", dot: "bg-yellow-500", bgColor: "bg-yellow-500", bg: "bg-yellow-50 dark:bg-yellow-900/20", chartColor: "#eab308", label: "Apify",        icon: <Globe className="h-3.5 w-3.5" />,    color: "text-yellow-700 dark:text-yellow-400" },
  gemini:       { desc: "Google Gemini text generation", dot: "bg-blue-500", bgColor: "bg-blue-500", bg: "bg-blue-50 dark:bg-blue-900/20", chartColor: "#3b82f6", label: "Gemini",       icon: <Sparkles className="h-3.5 w-3.5" />, color: "text-blue-600 dark:text-blue-400" },
  vertex_ai:    { desc: "Google Cloud Gemini generation", dot: "bg-sky-600", bgColor: "bg-sky-600", bg: "bg-sky-50 dark:bg-sky-900/20", chartColor: "#0284c7", label: "Vertex AI",    icon: <Sparkles className="h-3.5 w-3.5" />, color: "text-sky-700 dark:text-sky-400" },
  gemini_image: { desc: "Google Gemini image generation", dot: "bg-cyan-500", bgColor: "bg-cyan-500", bg: "bg-cyan-50 dark:bg-cyan-900/20", chartColor: "#06b6d4", label: "Gemini Image", icon: <Sparkles className="h-3.5 w-3.5" />, color: "text-cyan-700 dark:text-cyan-400" },
  gemini_video: { desc: "Google Gemini video generation", dot: "bg-violet-500", bgColor: "bg-violet-500", bg: "bg-violet-50 dark:bg-violet-900/20", chartColor: "#8b5cf6", label: "Gemini Video", icon: <Sparkles className="h-3.5 w-3.5" />, color: "text-violet-600 dark:text-violet-400" },
  zerobounce:   { desc: "Email validation & verification", dot: "bg-teal-500", bgColor: "bg-teal-500", bg: "bg-teal-50 dark:bg-teal-900/20", chartColor: "#14b8a6", label: "ZeroBounce",   icon: <Mail className="h-3.5 w-3.5" />,     color: "text-teal-700 dark:text-teal-400" },
  custom_ai:    { desc: "Custom OpenAI-compatible endpoint", dot: "bg-amber-500", bgColor: "bg-amber-500", bg: "bg-amber-50 dark:bg-amber-900/20", chartColor: "#f59e0b", label: "Custom AI",    icon: <Wand2 className="h-3.5 w-3.5" />,    color: "text-amber-700 dark:text-amber-400" },
  meta_whatsapp: { desc: "Meta's WhatsApp message charges", dot: "bg-green-600", bgColor: "bg-green-600", bg: "bg-green-50 dark:bg-green-900/20", chartColor: "#16a34a", label: "WhatsApp (Meta)", icon: <MessageCircle className="h-3.5 w-3.5" />, color: "text-green-700 dark:text-green-400" },
  platform:     { desc: "Internal platform credits", dot: "bg-slate-500", bgColor: "bg-slate-500", bg: "bg-slate-50 dark:bg-slate-900/20", chartColor: "#64748b", label: "Platform",     icon: <Building className="h-3.5 w-3.5" />, color: "text-muted-foreground" },
};

/** "lead_score_update" -> "Lead score update". */
export function humanizeReferenceType(type: string): string {
  const words = String(type || "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Other";
}

export function getBillingReferenceMeta(type: string): BillingReferenceMeta {
  return BILLING_REFERENCE_META[type] ?? {
    // A type added on the server before it gets a label here still reads as words, not a code.
    label: humanizeReferenceType(type),
    icon: <Wrench className="h-4 w-4" />,
    color: "text-muted-foreground",
    bgColor: "bg-gray-500",
  };
}

export function getBillingProviderMeta(provider: string | null | undefined): BillingProviderMeta {
  return BILLING_PROVIDER_META[provider || "platform"] ?? { ...BILLING_PROVIDER_META.platform, label: provider!, desc: "External API" };
}
