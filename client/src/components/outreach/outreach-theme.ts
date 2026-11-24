/**
 * Outreach Channel Theme Configuration
 * Defines colors, gradients, and styling for each outreach channel
 */

import { LucideIcon, Mail, Instagram, MessageCircle, MessageSquare, Facebook, Twitter, Linkedin } from "lucide-react";
import type { OutreachChannel } from "./types";

export interface ChannelTheme {
  // Channel info
  icon: LucideIcon;
  iconColor: string;
  channelName: string;

  // Outbound message bubble
  outboundBubble: string;
  outboundText: string;
  outboundTimestamp: string;

  // Inbound message bubble
  inboundBubble: string;
  inboundText: string;
  inboundTimestamp: string;

  // Sidebar selected item
  selectedBg: string;
  selectedBorder: string;
  hoverBg: string;

  // Avatar fallback gradient
  avatarGradient: string;

  // Send / New button gradient
  sendButton: string;
  newButton: string;

  // Loader color
  loaderColor: string;

  // Chat area background
  chatAreaBg: string;

  // Empty state
  emptyIconBg: string;

  // Top bar background
  topBarBg: string;
  headerBg: string;
  composeBg: string;

  // New Premium Design Tokens
  headerIconBg: string;
  iconBgLight: string;
  metaText: string;
  glassBg: string;
  containerGradient: string;
}

export const channelThemes: Record<OutreachChannel, ChannelTheme> = {
  email: {
    icon: Mail,
    iconColor: "text-blue-600",
    channelName: "Email Outreach",

    outboundBubble: "bg-primary/5 rounded-lg border border-primary/20 text-foreground",
    outboundText: "text-foreground",
    outboundTimestamp: "text-muted-foreground/60",

    inboundBubble: "bg-muted/40 rounded-lg border border-border/40",
    inboundText: "text-foreground",
    inboundTimestamp: "text-muted-foreground/60",

    selectedBg: "bg-white/60 dark:bg-white/10 shadow-xl border-primary/20",
    selectedBorder: "border-l-4 border-primary",
    hoverBg: "hover:bg-white/40 dark:hover:bg-white/5",

    avatarGradient: "bg-gradient-to-br from-blue-500 to-indigo-600",

    sendButton: "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg shadow-blue-500/20",
    newButton: "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg shadow-blue-500/20",

    loaderColor: "text-blue-500",
    chatAreaBg: "bg-transparent",
    emptyIconBg: "bg-blue-100 dark:bg-blue-900/30",

    topBarBg: "bg-background/40 backdrop-blur-md",
    headerBg: "bg-background/40 backdrop-blur-md",
    composeBg: "bg-background/40 backdrop-blur-md",

    headerIconBg: "bg-blue-600",
    iconBgLight: "bg-blue-600/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20",
  },
  instagram: {
    icon: Instagram,
    iconColor: "text-violet-500",
    channelName: "Instagram DMs",

    outboundBubble: "bg-gradient-to-br from-purple-500 via-violet-500 to-orange-500 text-white",
    outboundText: "text-white",
    outboundTimestamp: "text-white/70",

    inboundBubble: "bg-muted/40 rounded-lg border border-border/40",
    inboundText: "text-foreground",
    inboundTimestamp: "text-muted-foreground",

    selectedBg: "bg-violet-50 dark:bg-violet-950/30",
    selectedBorder: "border-l-4 border-violet-500",
    hoverBg: "hover:bg-gray-50 dark:hover:bg-slate-800",

    avatarGradient: "bg-gradient-to-br from-purple-500 via-violet-500 to-orange-500",

    sendButton: "bg-gradient-to-r from-purple-500 via-violet-500 to-orange-500 hover:opacity-90",
    newButton: "bg-gradient-to-r from-purple-500 via-violet-500 to-orange-500 hover:opacity-90",

    loaderColor: "text-violet-500",
    chatAreaBg: "bg-gray-50 dark:bg-slate-900",
    emptyIconBg: "bg-gradient-to-br from-purple-500 via-violet-500 to-orange-500",

    topBarBg: "bg-white dark:bg-slate-950",
    headerBg: "bg-white dark:bg-slate-950",
    composeBg: "bg-white dark:bg-slate-950",

    headerIconBg: "bg-violet-500",
    iconBgLight: "bg-violet-500/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-purple-50 via-violet-50 to-orange-50 dark:from-purple-950/20 dark:via-violet-950/20 dark:to-orange-950/20",
  },
  whatsapp: {
    icon: MessageCircle,
    iconColor: "text-green-600",
    channelName: "WhatsApp",

    outboundBubble: "bg-[#dcf8c6] dark:bg-green-900 rounded-tr-none",
    outboundText: "text-gray-800 dark:text-gray-200",
    outboundTimestamp: "text-muted-foreground",

    inboundBubble: "bg-white dark:bg-slate-800 rounded-tl-none shadow-sm",
    inboundText: "text-gray-800 dark:text-gray-200",
    inboundTimestamp: "text-muted-foreground",

    selectedBg: "bg-[#f0f2f5] dark:bg-slate-800",
    selectedBorder: "",
    hoverBg: "hover:bg-[#f0f2f5] dark:hover:bg-slate-800",

    avatarGradient: "bg-secondary text-muted-foreground",

    sendButton: "bg-green-500 hover:bg-green-600",
    newButton: "bg-green-500 hover:bg-green-600 text-white",

    loaderColor: "text-green-500",
    chatAreaBg: "bg-[#efeae2] dark:bg-slate-900/50",
    emptyIconBg: "bg-green-100 dark:bg-green-900/30",

    topBarBg: "bg-[#f0f2f5] dark:bg-slate-900 dark:border-slate-700",
    headerBg: "bg-[#f0f2f5] dark:bg-slate-900 dark:border-slate-700",
    composeBg: "bg-[#f0f2f5] dark:bg-slate-900 dark:border-slate-700",

    headerIconBg: "bg-green-600",
    iconBgLight: "bg-green-600/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20",
  },
  sms: {
    icon: MessageSquare,
    iconColor: "text-sky-600",
    channelName: "SMS Messages",

    outboundBubble: "bg-[#007AFF] text-white rounded-br-sm",
    outboundText: "text-white",
    outboundTimestamp: "text-blue-100",

    inboundBubble: "bg-[#E9E9EB] dark:bg-slate-700 rounded-bl-sm",
    inboundText: "text-black dark:text-gray-200",
    inboundTimestamp: "text-muted-foreground",

    selectedBg: "bg-accent",
    selectedBorder: "",
    hoverBg: "hover:bg-accent/50",

    avatarGradient: "bg-[#007AFF]",

    sendButton: "bg-[#007AFF] hover:bg-[#0056b3]",
    newButton: "bg-[#007AFF] hover:bg-[#0056b3] text-white",

    loaderColor: "text-[#007AFF]",
    chatAreaBg: "bg-muted/30",
    emptyIconBg: "",

    topBarBg: "bg-background",
    headerBg: "bg-background",
    composeBg: "bg-[#f2f2f7] dark:bg-slate-800",

    headerIconBg: "bg-sky-600",
    iconBgLight: "bg-sky-600/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-sky-50 to-blue-50 dark:from-sky-950/20 dark:to-blue-950/20",
  },
  facebook: {
    icon: Facebook,
    iconColor: "text-blue-600",
    channelName: "Facebook Messenger",

    outboundBubble: "bg-gradient-to-br from-blue-500 to-blue-600 text-white",
    outboundText: "text-white",
    outboundTimestamp: "text-white/70",

    inboundBubble: "bg-muted/40 rounded-lg border border-border/40",
    inboundText: "text-foreground",
    inboundTimestamp: "text-muted-foreground",

    selectedBg: "bg-blue-50 dark:bg-blue-950/30",
    selectedBorder: "border-l-4 border-blue-500",
    hoverBg: "hover:bg-gray-50 dark:hover:bg-slate-800",

    avatarGradient: "bg-gradient-to-br from-blue-500 to-blue-600",

    sendButton: "bg-blue-500 hover:bg-blue-600",
    newButton: "bg-blue-500 hover:bg-blue-600 text-white",

    loaderColor: "text-blue-500",
    chatAreaBg: "bg-gray-50 dark:bg-slate-900",
    emptyIconBg: "bg-blue-100 dark:bg-blue-900/30",

    topBarBg: "bg-white dark:bg-slate-950",
    headerBg: "bg-white dark:bg-slate-950",
    composeBg: "bg-white dark:bg-slate-950",

    headerIconBg: "bg-blue-600",
    iconBgLight: "bg-blue-500/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20",
  },
  twitter: {
    icon: Twitter,
    iconColor: "text-sky-500",
    channelName: "Twitter / X DMs",

    outboundBubble: "bg-gradient-to-br from-sky-400 to-sky-600 text-white",
    outboundText: "text-white",
    outboundTimestamp: "text-white/70",

    inboundBubble: "bg-muted/40 rounded-lg border border-border/40",
    inboundText: "text-foreground",
    inboundTimestamp: "text-muted-foreground",

    selectedBg: "bg-sky-50 dark:bg-sky-950/30",
    selectedBorder: "border-l-4 border-sky-500",
    hoverBg: "hover:bg-gray-50 dark:hover:bg-slate-800",

    avatarGradient: "bg-gradient-to-br from-sky-400 to-sky-600",

    sendButton: "bg-sky-500 hover:bg-sky-600",
    newButton: "bg-sky-500 hover:bg-sky-600 text-white",

    loaderColor: "text-sky-500",
    chatAreaBg: "bg-gray-50 dark:bg-slate-900",
    emptyIconBg: "bg-sky-100 dark:bg-sky-900/30",

    topBarBg: "bg-white dark:bg-slate-950",
    headerBg: "bg-white dark:bg-slate-950",
    composeBg: "bg-white dark:bg-slate-950",

    headerIconBg: "bg-sky-500",
    iconBgLight: "bg-sky-500/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-sky-50 to-cyan-50 dark:from-sky-950/20 dark:to-cyan-950/20",
  },
  linkedin: {
    icon: Linkedin,
    iconColor: "text-blue-700",
    channelName: "LinkedIn Messages",

    outboundBubble: "bg-gradient-to-br from-blue-600 to-blue-800 text-white",
    outboundText: "text-white",
    outboundTimestamp: "text-white/70",

    inboundBubble: "bg-muted/40 rounded-lg border border-border/40",
    inboundText: "text-foreground",
    inboundTimestamp: "text-muted-foreground",

    selectedBg: "bg-blue-50 dark:bg-blue-950/30",
    selectedBorder: "border-l-4 border-blue-700",
    hoverBg: "hover:bg-gray-50 dark:hover:bg-slate-800",

    avatarGradient: "bg-gradient-to-br from-blue-600 to-blue-800",

    sendButton: "bg-blue-700 hover:bg-blue-800",
    newButton: "bg-blue-700 hover:bg-blue-800 text-white",

    loaderColor: "text-blue-700",
    chatAreaBg: "bg-gray-50 dark:bg-slate-900",
    emptyIconBg: "bg-blue-100 dark:bg-blue-900/30",

    topBarBg: "bg-white dark:bg-slate-950",
    headerBg: "bg-white dark:bg-slate-950",
    composeBg: "bg-white dark:bg-slate-950",

    headerIconBg: "bg-blue-700",
    iconBgLight: "bg-blue-700/10",
    metaText: "font-black text-[10px] uppercase tracking-widest",
    glassBg: "bg-background/40 backdrop-blur-xl",
    containerGradient: "from-blue-50 to-slate-50 dark:from-blue-950/20 dark:to-slate-950/20",
  },
};

export function getChannelTheme(channel: OutreachChannel): ChannelTheme {
  const platform = channelThemes[channel];

  // Provider colors remain on the identifying icon. Operational state and
  // actions use the single AskSales blue so every channel behaves like one
  // product instead of a collection of unrelated mini-apps.
  return {
    ...platform,
    outboundBubble: "rounded-lg border border-primary bg-primary text-primary-foreground",
    outboundText: "text-primary-foreground",
    outboundTimestamp: "text-primary-foreground/70",
    inboundBubble: "rounded-lg border border-border bg-muted/40",
    inboundText: "text-foreground",
    inboundTimestamp: "text-muted-foreground",
    selectedBg: "bg-primary/10",
    selectedBorder: "border-l-2 border-primary",
    hoverBg: "hover:bg-primary/5",
    avatarGradient: "bg-primary text-primary-foreground",
    sendButton: "bg-primary text-primary-foreground hover:bg-primary/90",
    newButton: "bg-primary text-primary-foreground hover:bg-primary/90",
    loaderColor: "text-primary",
    chatAreaBg: "bg-background",
    emptyIconBg: "bg-primary/10 text-primary",
    topBarBg: "border-border bg-background",
    headerBg: "border-border bg-background",
    composeBg: "border-border bg-background",
    headerIconBg: "bg-primary",
    iconBgLight: "bg-primary/10",
    metaText: "font-mono text-[11px] font-medium",
    glassBg: "bg-background",
    containerGradient: "from-primary/5 to-primary/5",
  };
}
