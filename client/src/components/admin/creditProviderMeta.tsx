import type React from "react";
import { Bot, Building, Globe, Mail, Shuffle, Sparkles, Wand2 } from "lucide-react";

/** Label, icon and colour classes for each credit/API provider in the admin credit views. */
export const PROVIDER_META: Record<string, { label: string; icon: React.ReactNode; color: string; bgColor: string; barBg: string; border: string }> = {
  openai:     { label: "OpenAI",      icon: <Bot className="w-4 h-4 text-white" />,      color: "text-green-600",  bgColor: "bg-green-500",  barBg: "bg-green-50 dark:bg-green-900/20",  border: "border-green-100 dark:border-green-900/40" },
  openrouter: { label: "OpenRouter",  icon: <Shuffle className="w-4 h-4 text-white" />,  color: "text-indigo-600", bgColor: "bg-indigo-500", barBg: "bg-indigo-50 dark:bg-indigo-900/20", border: "border-indigo-100 dark:border-indigo-900/40" },
  apify:      { label: "Apify",       icon: <Globe className="w-4 h-4 text-white" />,    color: "text-yellow-600", bgColor: "bg-yellow-500", barBg: "bg-yellow-50 dark:bg-yellow-900/20", border: "border-yellow-100 dark:border-yellow-900/40" },
  gemini:     { label: "Gemini",      icon: <Sparkles className="w-4 h-4 text-white" />, color: "text-blue-600",   bgColor: "bg-blue-500",   barBg: "bg-blue-50 dark:bg-blue-900/20",   border: "border-blue-100 dark:border-blue-900/40" },
  zerobounce: { label: "ZeroBounce",  icon: <Mail className="w-4 h-4 text-white" />,     color: "text-teal-600",   bgColor: "bg-teal-500",   barBg: "bg-teal-50 dark:bg-teal-900/20",   border: "border-teal-100 dark:border-teal-900/40" },
  custom_ai:  { label: "Custom AI",   icon: <Wand2 className="w-4 h-4 text-white" />,    color: "text-amber-600",  bgColor: "bg-amber-500",  barBg: "bg-amber-50 dark:bg-amber-900/20", border: "border-amber-100 dark:border-amber-900/40" },
  platform:   { label: "Platform",    icon: <Building className="w-4 h-4 text-white" />, color: "text-slate-600",  bgColor: "bg-slate-500",  barBg: "bg-slate-50 dark:bg-slate-900/20", border: "border-slate-100 dark:border-slate-800" },
};
