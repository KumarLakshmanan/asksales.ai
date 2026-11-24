import { Mail, Phone, Calendar, MessageSquare, FileText, GitBranch, Instagram, MessageCircle, Smartphone, Linkedin, Twitter, Facebook } from "lucide-react";
export const ACTIVITY_ICONS: Record<string, typeof Mail> = {
  email: Mail, call: Phone, meeting: Calendar, note: MessageSquare, task: FileText, pipeline_change: GitBranch,
};

export const CHANNEL_CONFIG: Record<string, { icon: typeof Mail; label: string; color: string }> = {
  email: { icon: Mail, label: "Email", color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
  instagram: { icon: Instagram, label: "Instagram", color: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300" },
  sms: { icon: MessageCircle, label: "SMS", color: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" },
  whatsapp: { icon: Smartphone, label: "WhatsApp", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300" },
  linkedin: { icon: Linkedin, label: "LinkedIn", color: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300" },
  twitter: { icon: Twitter, label: "Twitter", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300" },
  facebook: { icon: Facebook, label: "Facebook", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300" },
};

export const CONV_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/10 text-green-700",
  replied: "bg-blue-500/10 text-blue-700",
  closed: "bg-muted text-muted-foreground",
  bounced: "bg-red-500/10 text-red-700",
  unsubscribed: "bg-orange-500/10 text-orange-700",
};

export const SENTIMENT_COLORS: Record<string, string> = {
  positive: "bg-green-100 text-green-700",
  negative: "bg-red-100 text-red-700",
  neutral: "bg-gray-100 text-gray-600",
  frustrated: "bg-red-100 text-red-700",
  satisfied: "bg-green-100 text-green-700",
};

export const TICKET_PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/10 text-red-700",
  high: "bg-orange-500/10 text-orange-700",
  medium: "bg-yellow-500/10 text-yellow-700",
  low: "bg-blue-500/10 text-blue-700",
};

export const TICKET_STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-500/10 text-blue-700",
  pending: "bg-yellow-500/10 text-yellow-700",
  resolved: "bg-green-500/10 text-green-700",
  closed: "bg-muted text-muted-foreground",
};

export const SLA_STATUS_COLORS: Record<string, string> = {
  breached: "bg-red-500/10 text-red-700",
  at_risk: "bg-orange-500/10 text-orange-700",
  healthy: "bg-green-500/10 text-green-700",
  no_sla: "bg-muted text-muted-foreground",
};
