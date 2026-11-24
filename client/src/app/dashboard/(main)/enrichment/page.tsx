"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { enrichmentRequestKey, completeEnrichmentRequest } from "@/lib/enrichment-request";
import { hasStaleEnrichmentActivity, updateEnrichmentProgress, type EnrichmentProgressState } from "@/lib/enrichment-progress";
import { cleanEnrichmentPhone, cleanEnrichmentRun } from "../../../../../../shared/enrichmentContactValidation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { CopyButton } from "@/components/ui/copy-button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { maskEmail } from "@/lib/mask-email";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  Sparkles,
  Search,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  User,
  Globe,
  Mail,
  Phone,
  Linkedin,
  Instagram,
  Facebook,
  Twitter,
  Brain,
  RefreshCw,
  Plus,
  ChevronRight,
  ChevronDown,
  Database,
  Activity,
  ExternalLink,
  Building2,
  MapPin,
  Youtube,
  Github,
  MessageSquare,
  Pin,
  Music,
  Briefcase,
  Code,
  Users,
  DollarSign,
  Calendar,
  FileText,
  AlertCircle,
} from "lucide-react";

// ─── Types (matching Drizzle camelCase) ─────────────────────────────
interface EnrichmentStep {
  id: number;
  runId: number;
  stepNumber: number;
  stepType: string;
  platform?: string | null;
  actorId?: string | null;
  subType?: string | null;
  identifier?: string | null;
  status: string;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  itemsCount?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  createdAt: string;
}

interface EnrichmentRun {
  id: number;
  userId: number;
  leadId?: number | null;
  leadName?: string | null;
  leadEmail?: string | null;
  status: string;
  startedAt?: string;
  completedAt?: string | null;
  totalHandlesProcessed?: number | null;
  totalIterations?: number | null;
  emailsFound?: number | null;
  phonesFound?: number | null;
  websitesFound?: number | null;
  errorMessage?: string | null;
  billingStatus?: string | null;
  summary?: Record<string, unknown> | null;
  createdAt: string;
}

interface EnrichmentRunWithSteps extends EnrichmentRun {
  steps: EnrichmentStep[];
}

type EnrichmentPlatform = "instagram" | "linkedin" | "twitter" | "facebook" | "website";
type FilterStatus = "all" | "running" | "completed" | "failed";

interface LeadOption {
  id: number;
  name: string;
  email?: string;
  company?: string;
}

interface EnrichmentProgressEvent {
  toolName?: string;
  executionId?: string;
  iteration?: number;
  platform?: string;
  identifier?: string;
  total?: number;
  iterations?: number;
  totalHandles?: number;
  emails?: number;
  status?: string;
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────
const getPlatformIcon = (platform?: string | null) => {
  switch (platform?.toLowerCase()) {
    case "instagram": return Instagram;
    case "linkedin": return Linkedin;
    case "twitter":
    case "x": return Twitter;
    case "facebook": return Facebook;
    case "youtube": return Youtube;
    case "github": return Github;
    case "tiktok": return Music;
    case "pinterest": return Pin;
    case "whatsapp": return MessageSquare;
    case "website": return Globe;
    default: return User;
  }
};

const getPlatformColor = (platform?: string | null) => {
  switch (platform?.toLowerCase()) {
    case "instagram": return "from-pink-500 to-purple-500";
    case "linkedin": return "from-blue-600 to-blue-400";
    case "twitter":
    case "x": return "from-sky-500 to-blue-500";
    case "facebook": return "from-blue-700 to-blue-500";
    case "youtube": return "from-red-600 to-red-400";
    case "github": return "from-gray-700 to-gray-500";
    case "tiktok": return "from-pink-500 to-orange-500";
    case "pinterest": return "from-red-600 to-pink-500";
    case "whatsapp": return "from-green-500 to-emerald-400";
    case "website": return "from-emerald-500 to-teal-500";
    default: return "from-violet-500 to-purple-600";
  }
};

const getStepLabel = (stepType: string) => {
  const map: Record<string, string> = {
    actor_run: "Apify Actor Run",
    handle_discovery: "Handle Discovery",
    llm_extraction: "LLM Field Extraction",
    lead_update: "Lead Record Updated",
  };
  return map[stepType] || stepType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

const getStepIcon = (stepType: string) => {
  const map: Record<string, typeof Sparkles> = {
    actor_run: Activity,
    handle_discovery: Search,
    llm_extraction: Brain,
    lead_update: Database,
  };
  return map[stepType] || Sparkles;
};

const getStepDescription = (step: EnrichmentStep) => {
  switch (step.stepType) {
    case "actor_run": {
      const actor = step.actorId?.split("/").pop() || "unknown";
      const items = step.itemsCount ?? 0;
      return `Ran ${actor} on ${step.platform || "unknown"} for "${step.identifier || "?"}" — ${items} item${items !== 1 ? "s" : ""} scraped`;
    }
    case "handle_discovery": {
      const output = step.output as Record<string, number> | null;
      const input = step.input as Record<string, unknown> | null;
      const newHandlesList = (input?.newHandles as string[] | undefined) || [];
      const newHandles = output?.newPlatformHandles ?? newHandlesList.length;
      const secondary = output?.secondaryActors ?? 0;
      // Build a readable list of discovered platforms
      const platforms = [...new Set(newHandlesList.map(h => h.split(':')[0]))];
      const platformSummary = platforms.length > 0 ? ` (${platforms.join(', ')})` : '';
      return `Discovered ${newHandles} new handle${newHandles !== 1 ? "s" : ""}${platformSummary}${secondary > 0 ? ` + ${secondary} secondary actor${secondary !== 1 ? "s" : ""} queued` : ""}`;
    }
    case "llm_extraction": {
      const output = step.output as Record<string, number> | null;
      const fields = output?.fieldsExtracted ?? 0;
      return `LLM extracted ${fields} structured field${fields !== 1 ? "s" : ""} from raw scraped data`;
    }
    case "lead_update": {
      const output = step.output as Record<string, number> | null;
      const parts: string[] = [];
      if (output?.emailsFound) parts.push(`${output.emailsFound} email${output.emailsFound !== 1 ? "s" : ""}`);
      if (output?.phonesFound) parts.push(`${output.phonesFound} phone${output.phonesFound !== 1 ? "s" : ""}`);
      if (output?.websitesFound) parts.push(`${output.websitesFound} website${output.websitesFound !== 1 ? "s" : ""}`);
      if (output?.socialProfiles) parts.push(`${output.socialProfiles} social profile${output.socialProfiles !== 1 ? "s" : ""}`);
      return parts.length > 0 ? `Updated lead with ${parts.join(", ")}` : "Lead record updated";
    }
    default:
      return step.identifier ? `Processing ${step.identifier}` : "Processing...";
  }
};

const formatDuration = (ms?: number | null) => {
  if (ms == null) return "";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

// Phone formatting utilities
const normalizePhoneToE164 = (phone: string): string => {
  return cleanEnrichmentPhone(phone) || '';
};

const formatPhoneForDisplay = (phone: string): string => {
  return normalizePhoneToE164(phone);
};

// Extract bare handle from social URL for display
const extractHandleFromUrl = (platform: string, url: string): string => {
  if (!url) return '';
  if (!url.startsWith('http') && !url.includes('.')) return url.replace(/^@/, '');
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const pathname = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    switch (platform.toLowerCase()) {
      case 'instagram': return pathname.split('/')[0] || '';
      case 'twitter':
      case 'x': return pathname.split('/')[0] || '';
      case 'linkedin': {
        const parts = pathname.split('/');
        if (parts[0] === 'in' || parts[0] === 'company') return parts[1] || '';
        return parts[0] || '';
      }
      case 'facebook': return pathname.split('/')[0] || '';
      case 'youtube': {
        if (pathname.startsWith('@')) return pathname.slice(1);
        const ytParts = pathname.split('/');
        return ytParts[ytParts.length - 1] || '';
      }
      case 'github': return pathname.split('/')[0] || '';
      case 'tiktok': return pathname.replace(/^@/, '') || '';
      case 'pinterest': return pathname.split('/')[0] || '';
      case 'whatsapp': return parsed.searchParams.get('phone') || pathname || '';
      default: return pathname.split('/')[0] || '';
    }
  } catch {
    return url.replace(/^@/, '');
  }
};

// Parse a date string safely — treats naive strings (no timezone suffix) as UTC
// so they display correctly regardless of the browser's local timezone.
const parseEnrichmentDate = (date: string): Date => {
  // If the string already has a timezone indicator (Z or +/-offset), trust it
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(date)) return new Date(date);
  // Otherwise it came from a TIMESTAMP WITHOUT TIME ZONE column stored in UTC — append Z
  return new Date(date + 'Z');
};

const formatTimeDiff = (start?: string | null, end?: string | null) => {
  if (!start) return "";
  const s = parseEnrichmentDate(start).getTime();
  const e = end ? parseEnrichmentDate(end).getTime() : Date.now();
  const diff = Math.round((e - s) / 1000);
  if (diff <= 0) return "0s";
  if (diff < 60) return `${diff}s`;
  return `${Math.floor(diff / 60)}m ${diff % 60}s`;
};

const formatTime = (date?: string | null) => {
  if (!date) return "";
  return formatDistanceToNow(parseEnrichmentDate(date), { addSuffix: true });
};

const getInitials = (name?: string | null) => {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
};

const getStatusColor = (status: string) => {
  switch (status) {
    case "completed": return "bg-emerald-500";
    case "running": case "pending": return "bg-blue-500";
    case "failed": return "bg-red-500";
    default: return "bg-gray-500";
  }
};

// ─── StatusBadge ────────────────────────────────────────────────────
const RUN_STATUS_LABELS: Record<string, string> = { completed: "Completed", running: "Running", pending: "Pending", failed: "Failed" };

function RunStatusBadge({ status, stale = false }: { status: string; stale?: boolean }) {
  // Unknown statuses read as pending, as before.
  const known = status in RUN_STATUS_LABELS ? status : "pending";
  const label = RUN_STATUS_LABELS[known];
  return (
    <StatusBadge
      status={known}
      // A stale "running" record is not live, so it must not pulse like active work.
      tone={stale && known === "running" ? "info" : undefined}
      label={stale ? `Recorded: ${label}` : label}
    />
  );
}

// ─── Live Progress Banner ───────────────────────────────────────────
function LiveProgressBanner({ progress }: { progress: EnrichmentProgressEvent | null }) {
  if (!progress) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="mx-6 mt-2 px-4 py-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center gap-3"
    >
      <Spinner size="sm" label={null} className="text-blue-700 dark:text-blue-300" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
          Iteration {progress.iteration || "?"} — {progress.platform || "processing"}
          {progress.identifier && <span className="text-blue-700 dark:text-blue-300"> · {progress.identifier}</span>}
        </p>
        <p className="mt-0.5 text-[10px] text-blue-700 dark:text-blue-300">
          {progress.total ? `${progress.total} handles tracked` : "Processing..."}
        </p>
      </div>
      <Activity className="h-3.5 w-3.5 shrink-0 text-blue-700 dark:text-blue-300" />
    </motion.div>
  );
}

// ─── StepBubble ─────────────────────────────────────────────────────
function StepBubble({ step, index, stale = false }: { step: EnrichmentStep; index: number; stale?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isLeft = step.stepType === "actor_run" || step.stepType === "llm_extraction";
  const duration = formatDuration(step.durationMs);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      className={cn("flex gap-3 max-w-[85%]", isLeft ? "self-start" : "self-end flex-row-reverse")}
    >
      <div className={cn(
        "w-8 h-8 rounded-xl flex items-center justify-center shrink-0",
        step.status === "completed" ? "bg-emerald-500/20 text-emerald-400" :
        step.status === "failed" ? "bg-red-500/20 text-red-400" :
        step.status === "running" ? "bg-blue-500/20 text-blue-400" :
        "bg-gray-500/20 text-gray-400"
      )}>
        {step.status === "running" && !stale ? (
          <Spinner size="sm" label={null} />
        ) : (
          React.createElement(getStepIcon(step.stepType), { className: "w-4 h-4" })
        )}
      </div>

      <div
        className={cn(
          "rounded-2xl px-4 py-3 cursor-pointer transition-all min-w-[200px]",
          isLeft
            ? "bg-muted/40 hover:bg-muted/60 rounded-tl-sm"
            : "bg-violet-500/10 hover:bg-violet-500/15 rounded-tr-sm"
        )}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 mb-1">
          {step.platform && getPlatformIcon(step.platform) && React.createElement(getPlatformIcon(step.platform)!, { className: "w-3.5 h-3.5 text-muted-foreground" })}
          <span className="text-sm font-medium text-foreground/90">{getStepLabel(step.stepType)}</span>
          <ChevronDown className={cn(
            "w-3 h-3 text-muted-foreground transition-transform ml-auto",
            expanded && "rotate-180"
          )} />
        </div>

        <p className="text-xs text-muted-foreground mb-1.5">{getStepDescription(step)}</p>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {step.status === "completed" && <CheckCircle2 aria-hidden="true" className="w-3 h-3 text-emerald-400" />}
          {step.status === "failed" && <XCircle aria-hidden="true" className="w-3 h-3 text-red-400" />}
          {step.status === "running" && !stale && <Spinner size="xs" label={null} className="text-blue-400" />}
          <span className="capitalize">{step.status}</span>
          {duration && <span><span aria-hidden="true">· </span><span className="sr-only">Elapsed time: </span>{duration}</span>}
          {step.actorId && <span>· {step.actorId.split("/").pop()}</span>}
          {step.itemsCount != null && step.itemsCount > 0 && (
            <span>· {step.itemsCount} items</span>
          )}
        </div>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-3 pt-3 border-t border-border space-y-2">
                {step.errorMessage && (
                  <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                    {step.errorMessage}
                  </div>
                )}
                {step.platform && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground/60">Platform:</span>
                    <span className="text-foreground/60 capitalize">{step.platform}</span>
                    {step.subType && step.subType !== "primary" && (
                      <Badge variant="outline" className="text-[10px] border-border text-muted-foreground py-0 px-1.5">
                        {step.subType}
                      </Badge>
                    )}
                  </div>
                )}
                {step.identifier && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground/60">Target:</span>
                    <span className="text-foreground/60 font-mono">{step.identifier}</span>
                  </div>
                )}
                {step.actorId && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground/60">Actor:</span>
                    <span className="text-foreground/60 font-mono">{step.actorId}</span>
                  </div>
                )}
                {step.input && Object.keys(step.input).length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground/60 uppercase tracking-wider">Input</span>
                    <pre className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-2 mt-1 overflow-x-auto max-h-32">
                      {JSON.stringify(step.input, null, 2)}
                    </pre>
                  </div>
                )}
                {step.output && Object.keys(step.output).length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground/60 uppercase tracking-wider">Output</span>
                    <pre className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-2 mt-1 overflow-x-auto max-h-32">
                      {JSON.stringify(step.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ─── EnrichmentResultsPanel ─────────────────────────────────────────
function EnrichmentResultsPanel({ run }: { run: EnrichmentRunWithSteps }) {
  const summary = run.summary as Record<string, unknown> | null;

  const socialProfiles: Record<string, string> =
    summary?.socialProfiles && typeof summary.socialProfiles === "object" && !Array.isArray(summary.socialProfiles)
      ? (summary.socialProfiles as Record<string, string>)
      : {};
  const emails: string[] = Array.isArray(summary?.emails) ? (summary.emails as string[]) : [];
  const phones: string[] = Array.isArray(summary?.phones) ? (summary.phones as string[]) : [];
  const websites: string[] = Array.isArray(summary?.websites) ? (summary.websites as string[]) : [];
  const person = (summary?.person || {}) as Record<string, string>;
  const company = (summary?.company || {}) as Record<string, string>;
  const leadScore = typeof summary?.leadScore === "number" ? summary.leadScore : null;
  const socialStats = (summary?.socialStats || {}) as Record<string, string | number | boolean | null | undefined>;

  const hasSocialProfiles = Object.values(socialProfiles).some(Boolean);
  const hasData =
    emails.length > 0 || phones.length > 0 || websites.length > 0 ||
    hasSocialProfiles || person.fullName || company.name || leadScore !== null;

  if (!hasData) return null;

  return (
    <div className="mt-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-emerald-500/10 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
        <span className="text-sm font-medium text-emerald-800 dark:text-emerald-200">Extracted data</span>
      </div>
      <div className="p-4 space-y-4">
        {typeof summary?.failedSources === 'number' && summary.failedSources > 0 && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">Some enrichment sources failed. These are partial results.</p>}
        <p className="text-xs text-muted-foreground">
          Contact candidates from scraped sources—not verified personal contact details. Company mailboxes and numbers may be included. Invalid and duplicate values are hidden; local numbers retain their original country context. Legacy social totals without subject attribution are hidden. Other scraped fields may describe a linked organization rather than this person.
        </p>
        {/* Lead Score */}
        {leadScore !== null && (
          <div className="flex items-center gap-4 p-3 rounded-xl bg-muted/30 border border-border">
            <div className="flex-1">
              <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1.5">Outreach Strength</p>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 bg-muted/50 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      leadScore >= 75 ? "bg-emerald-500" :
                      leadScore >= 50 ? "bg-amber-500" :
                      "bg-red-500"
                    )}
                    style={{ width: `${leadScore}%` }}
                  />
                </div>
                <span className={cn(
                  "text-lg font-bold tabular-nums",
                  leadScore >= 75 ? "text-emerald-400" :
                  leadScore >= 50 ? "text-amber-400" :
                  "text-red-400"
                )}>
                  {leadScore}
                </span>
                <span className="text-xs text-muted-foreground/60">/ 100</span>
              </div>
            </div>
          </div>
        )}
        {/* Person */}
        {(person.fullName || person.title || person.location || person.bio || person.headline || person.seniority || person.skills) && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">Person</p>
            <div className="space-y-1.5">
              {person.fullName && (
                <div className="flex items-center gap-2 text-sm">
                  <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-foreground/80">{person.fullName}</span>
                  {person.title && <span className="text-muted-foreground/60">· {person.title}</span>}
                </div>
              )}
              {person.headline && (
                <p className="text-xs text-muted-foreground/70 pl-5 line-clamp-2">{person.headline}</p>
              )}
              {person.location && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span>{person.location}</span>
                </div>
              )}
              {person.seniority && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <Briefcase className="w-3.5 h-3.5 shrink-0" />
                  <span>Seniority: {person.seniority}</span>
                </div>
              )}
              {person.skills && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5 flex-wrap">
                  <Code className="w-3.5 h-3.5 shrink-0" />
                  <span>{Array.isArray(person.skills) ? person.skills.join(', ') : person.skills}</span>
                </div>
              )}
              {person.bio && (
                <p className="text-xs text-muted-foreground/70 pl-5 line-clamp-3">{person.bio}</p>
              )}
            </div>
          </div>
        )}

        {/* Company */}
        {(company.name || company.industry || company.domain || company.size || company.revenue || company.founded || company.techStack || company.description) && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">Company</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm">
                <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                {company.name && <span className="text-foreground/80">{company.name}</span>}
                {company.industry && <span className="text-muted-foreground/60">· {company.industry}</span>}
              </div>
              {company.domain && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <Globe className="w-3.5 h-3.5 shrink-0" />
                  <span>{company.domain}</span>
                </div>
              )}
              {company.size && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <Users className="w-3.5 h-3.5 shrink-0" />
                  <span>{company.size} employees</span>
                </div>
              )}
              {company.revenue && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <DollarSign className="w-3.5 h-3.5 shrink-0" />
                  <span>Revenue: {company.revenue}</span>
                </div>
              )}
              {company.founded && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <Calendar className="w-3.5 h-3.5 shrink-0" />
                  <span>Founded: {company.founded}</span>
                </div>
              )}
              {company.address && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-0.5">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span>{company.address}</span>
                </div>
              )}
              {company.techStack && (
                <div className="flex items-center gap-0 gap-2 text-xs text-muted-foreground pl-0.5 flex-wrap">
                  <Code className="w-3.5 h-3.5 shrink-0" />
                  <span>{Array.isArray(company.techStack) ? company.techStack.join(', ') : company.techStack}</span>
                </div>
              )}
              {company.description && (
                <p className="text-xs text-muted-foreground/70 pl-5 line-clamp-2">{company.description}</p>
              )}
            </div>
          </div>
        )}

        {/* Emails */}
        {emails.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">
              Emails <span className="text-muted-foreground/40">({emails.length})</span>
            </p>
            <div className="space-y-1">
              {emails.map((email, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  <Mail className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span className="text-sm text-foreground/80 font-mono flex-1 truncate">{email}</span>
                  <CopyButton value={email} label={`Copy email ${email}`} iconOnly variant="ghost" className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Phones */}
        {phones.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">
              Phones <span className="text-muted-foreground/40">({phones.length})</span>
            </p>
            <div className="space-y-1">
              {phones.map((phone, i) => {
                const formatted = formatPhoneForDisplay(phone);
                const e164 = normalizePhoneToE164(phone);
                return (
                  <div key={i} className="flex items-center gap-2 group">
                    <Phone className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-foreground/80 font-mono truncate">{formatted}</span>
                      {e164 !== formatted && (
                        <span className="text-xs text-muted-foreground/50 font-mono ml-2">({e164})</span>
                      )}
                    </div>
                    <CopyButton value={e164} label={`Copy phone ${e164}`} iconOnly variant="ghost" className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Websites */}
        {websites.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">
              Websites <span className="text-muted-foreground/40">({websites.length})</span>
            </p>
            <div className="space-y-1">
              {websites.map((site, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <a
                    href={site.startsWith("http") ? site : `https://${site}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-400/80 hover:text-blue-400 transition-colors truncate flex-1"
                  >
                    {site.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                  <ExternalLink className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Social Profiles */}
        {hasSocialProfiles && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">Social Profiles</p>
            <div className="space-y-1.5">
              {Object.entries(socialProfiles).map(([platform, url]) => {
                if (!url) return null;
                const Icon = getPlatformIcon(platform);
                const handle = extractHandleFromUrl(platform, url);
                const displayText = handle ? `@${handle}` : url.replace(/^https?:\/\/(www\.)?/, "");
                return (
                  <div key={platform} className="flex items-center gap-2">
                    <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <a
                      href={url.startsWith("http") ? url : `https://${url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-400/80 hover:text-blue-400 transition-colors truncate flex-1"
                    >
                      {displayText}
                    </a>
                    <ExternalLink className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Social Stats */}
        {(socialStats.followersCount || socialStats.followingCount || socialStats.postsCount) && (
          <div>
            <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-2">Social Stats</p>
            <div className="flex flex-wrap gap-4 text-sm">
              {socialStats.followersCount != null && (
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-foreground/80 font-medium">{Number(socialStats.followersCount).toLocaleString()}</span>
                  <span className="text-muted-foreground/60">Followers</span>
                </div>
              )}
              {socialStats.followingCount != null && (
                <div className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-foreground/80 font-medium">{Number(socialStats.followingCount).toLocaleString()}</span>
                  <span className="text-muted-foreground/60">Following</span>
                </div>
              )}
              {socialStats.postsCount != null && (
                <div className="flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-foreground/80 font-medium">{Number(socialStats.postsCount).toLocaleString()}</span>
                  <span className="text-muted-foreground/60">Posts</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NewEnrichmentDialog ────────────────────────────────────────────
function NewEnrichmentDialog({
  open,
  onOpenChange,
  onEnrichHandle,
  onEnrichLead,
  isSubmitting,
  onReturnFocus,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEnrichHandle: (platform: EnrichmentPlatform, identifier: string) => void;
  onEnrichLead: (leadId: number) => void;
  isSubmitting: boolean;
  onReturnFocus: () => void;
}) {
  const identifierId = useId();
  const [tab, setTab] = useState<"handle" | "lead">("handle");
  const [platform, setPlatform] = useState<EnrichmentPlatform>("instagram");
  const [identifier, setIdentifier] = useState("");
  const [leadSearch, setLeadSearch] = useState("");

  const { data: leads, isLoading: leadsLoading, isError: leadsError, refetch: refetchLeads } = useQuery({
    queryKey: ["leads-search", leadSearch],
    queryFn: () => api.get<{ data: LeadOption[] }>(`/api/leads?search=${encodeURIComponent(leadSearch.trim())}&pageSize=20&sortBy=name_asc`),
    enabled: open && tab === "lead",
  });

  const platformOptions: { id: EnrichmentPlatform; label: string; icon: typeof Instagram }[] = [
    { id: "instagram", label: "Instagram", icon: Instagram },
    { id: "linkedin", label: "LinkedIn", icon: Linkedin },
    { id: "twitter", label: "Twitter", icon: Twitter },
    { id: "facebook", label: "Facebook", icon: Facebook },
    { id: "website", label: "Website", icon: Globe },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-background/95 backdrop-blur-xl border-border" onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}>
        <DialogHeader>
          <DialogTitle className="text-foreground">New Enrichment</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Start a new lead enrichment by handle or from an existing lead.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "handle" | "lead")} className="mt-2">
          <TabsList className="bg-muted/40 w-full">
            <TabsTrigger value="handle" className="flex-1 text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              By Handle
            </TabsTrigger>
            <TabsTrigger value="lead" className="flex-1 text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              From Lead
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "handle" && (
          <div className="space-y-4 mt-4">
            <div>
              <Label className="text-muted-foreground text-xs mb-2 block">Platform</Label>
              <div className="grid grid-cols-5 gap-2">
                {platformOptions.map((p) => {
                  const Icon = p.icon;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setPlatform(p.id)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-xs",
                        platform === p.id
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border bg-muted/20 text-muted-foreground hover:bg-muted/40"
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label htmlFor={identifierId} className="text-muted-foreground text-xs mb-2 block">Handle / URL</Label>
              <Input
                id={identifierId}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={platform === "website" ? "https://example.com" : "@username"}
                className="bg-muted/40 border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>
        )}

        {tab === "lead" && (
          <div className="space-y-3 mt-4">
            <SearchInput
              aria-label="Search leads by name or email"
              value={leadSearch}
              onValueChange={setLeadSearch}
              placeholder="Search leads by name or email..."
              className="bg-muted/40 border-border text-foreground"
            />
            <ScrollArea className="h-48">
              <div className="space-y-1">
                {leadsLoading && (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                    <Spinner size="sm" label={null} /> Loading leads…
                  </div>
                )}
                {leadsError && (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs text-destructive">
                    <AlertCircle className="h-4 w-4" /> Leads could not be loaded.
                    <Button variant="outline" size="sm" onClick={() => refetchLeads()}>Retry lead search</Button>
                  </div>
                )}
                {leads?.data?.map((lead: LeadOption) => (
                  <button
                    key={lead.id}
                    onClick={() => onEnrichLead(lead.id)}
                    disabled={isSubmitting}
                    className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/40 transition-colors text-left"
                  >
                    <Avatar className="w-8 h-8 rounded-xl">
                      <AvatarFallback className="rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white text-xs">
                        {getInitials(lead.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-sm text-foreground/90 truncate">{lead.name?.trim() || lead.email || `Lead #${lead.id}`}</p>
                      {lead.email && <p className="text-xs text-muted-foreground truncate">{lead.email}</p>}
                    </div>
                  </button>
                ))}
                {!leadsLoading && !leadsError && !leads?.data?.length && (
                  <p className="text-xs text-muted-foreground/60 text-center py-4">No leads found</p>
                )}
              </div>
            </ScrollArea>
          </div>
        )}

        {tab === "handle" && (
          <DialogFooter className="mt-4">
            <Button
              onClick={() => onEnrichHandle(platform, identifier)}
              disabled={!identifier.trim()}
              loading={isSubmitting}
              loadingText="Starting enrichment…"
              className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white border-0"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Start Enrichment
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────
export default function EnrichmentPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocket();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const newDialogOpener = useRef<HTMLButtonElement | null>(null);
  const [progressByRun, setProgressByRun] = useState<EnrichmentProgressState>({});
  const liveProgress = selectedRunId ? progressByRun[selectedRunId] || null : null;
  const detailScrollRef = useRef<HTMLDivElement>(null);

  // ─── WebSocket real-time updates ─────────────────────────────────
  useEffect(() => {
    const isEnrichmentEvent = (data: Record<string, unknown>) => data.toolName === "deep_enrichment" || data.toolName === "handle_enrichment";
    const unsubStarted = subscribe("events:tool:started", (data: Record<string, unknown>) => {
      if (!isEnrichmentEvent(data)) return;
      setProgressByRun(state => updateEnrichmentProgress(state, 'started', data));
      queryClient.invalidateQueries({ queryKey: ["enrichment-runs"] });
    });

    const unsubProgress = subscribe("events:tool:progress", (data: Record<string, unknown>) => {
      if (!isEnrichmentEvent(data)) return;
      setProgressByRun(state => updateEnrichmentProgress(state, 'progress', data));
      queryClient.invalidateQueries({ queryKey: ["enrichment-run"] });
    });

    const unsubCompleted = subscribe("events:tool:completed", (data: Record<string, unknown>) => {
      if (!isEnrichmentEvent(data)) return;
      setProgressByRun(state => updateEnrichmentProgress(state, 'completed', data));
      toast({ title: "Enrichment Complete", description: `Processed ${data.totalHandles || "?"} handles, found ${data.emails || 0} emails` });
      queryClient.invalidateQueries({ queryKey: ["wallet-balance"] });
      queryClient.invalidateQueries({ queryKey: ["wallet"] });
      queryClient.invalidateQueries({ queryKey: ["enrichment-runs"] });
      queryClient.invalidateQueries({ queryKey: ["enrichment-run"] });
    });

    const unsubFailed = subscribe("events:tool:failed", (data: Record<string, unknown>) => {
      if (!isEnrichmentEvent(data)) return;
      setProgressByRun(state => updateEnrichmentProgress(state, 'failed', data));
      toast({ title: "Enrichment Failed", description: (data.error as string) || "An error occurred", variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["wallet-balance"] });
      queryClient.invalidateQueries({ queryKey: ["wallet"] });
      queryClient.invalidateQueries({ queryKey: ["enrichment-runs"] });
      queryClient.invalidateQueries({ queryKey: ["enrichment-run"] });
    });

    return () => {
      unsubStarted();
      unsubProgress();
      unsubCompleted();
      unsubFailed();
    };
  }, [subscribe, queryClient, toast]);

  useEffect(() => {
    if (detailScrollRef.current && liveProgress) {
      const el = detailScrollRef.current.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') || detailScrollRef.current;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isNearBottom) {
        const timer = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }), 100);
        return () => clearTimeout(timer);
      }
    }
  }, [liveProgress]);

  // ─── Data Fetching ───────────────────────────────────────────────
  const { data: runsData, isLoading: runsLoading, isError: runsError, refetch: refetchRuns } = useQuery({
    queryKey: ["enrichment-runs"],
    queryFn: () => api.get<EnrichmentRun[]>("/api/enrichments?limit=100"),
    refetchInterval: 10000,
  });

  const runs: EnrichmentRun[] = useMemo(() => ((runsData as EnrichmentRun[]) || []).map(cleanEnrichmentRun), [runsData]);

  const { data: detailData, isLoading: detailLoading, isError: detailError, refetch: refetchDetail } = useQuery({
    queryKey: ["enrichment-run", selectedRunId],
    queryFn: () => api.get<EnrichmentRunWithSteps>(`/api/enrichments/${selectedRunId}`),
    enabled: !!selectedRunId,
    refetchInterval: (query) => {
      const run = (query.state.data as EnrichmentRunWithSteps | undefined);
      return run?.status === "running" || run?.status === "pending" ? 5000 : false;
    },
  });

  const selectedRun: EnrichmentRunWithSteps | null = detailData ? cleanEnrichmentRun(detailData as EnrichmentRunWithSteps) : null;
  const staleActivity = selectedRun ? hasStaleEnrichmentActivity(selectedRun, liveProgress) : false;
  const awaitingTerminalRefresh = selectedRun && ['running', 'pending'].includes(selectedRun.status) && liveProgress && ['completed', 'failed'].includes(liveProgress.status);

  // ─── Mutations ───────────────────────────────────────────────────
  const enrichHandleMutation = useMutation({
    mutationFn: (data: { platform: string; identifier: string }) =>
      api.post<{ runId?: number; replayed?: boolean; status?: string }>("/api/enrichments/by-handle", data, { headers: { 'Idempotency-Key': enrichmentRequestKey(data) } }),
    onSuccess: (res: { runId?: number; replayed?: boolean; status?: string }, data: { platform: string; identifier: string }) => {
      completeEnrichmentRequest(data);
      queryClient.invalidateQueries({ queryKey: ["wallet-balance"] });
      queryClient.invalidateQueries({ queryKey: ["wallet"] });
      toast({ title: res.replayed ? "Existing enrichment reopened" : "Enrichment started", description: res.replayed ? "Showing the saved request. No new enrichment was started." : "Processing in the background..." });
      setNewDialogOpen(false);
      refetchRuns();
      if (res?.runId) setSelectedRunId(res.runId);
    },
    onError: (err: { message?: string }) => {
      toast({ title: "Failed", description: err?.message || "Could not start enrichment", variant: "destructive" });
    },
  });

  const enrichLeadMutation = useMutation({
    mutationFn: (leadId: number) => api.post<{ jobId: string; correlationId: string; runId?: number }>(`/api/leads/${leadId}/deep-enrich`, { async: true }, { headers: { 'Idempotency-Key': enrichmentRequestKey({ platform: 'lead', identifier: String(leadId) }) } }),
    onSuccess: (res, leadId) => {
      completeEnrichmentRequest({ platform: 'lead', identifier: String(leadId) });
      queryClient.invalidateQueries({ queryKey: ['wallet-balance'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      if (res.runId) setSelectedRunId(res.runId);
      toast({ title: "Enrichment queued", description: "The enrichment worker is processing this lead." });
      setNewDialogOpen(false);
      refetchRuns();
      window.setTimeout(() => { void refetchRuns(); }, 1500);
    },
    onError: (err: { message?: string }) => {
      toast({ title: "Failed", description: err?.message || "Could not start enrichment", variant: "destructive" });
    },
  });

  // ─── Filtered Runs ──────────────────────────────────────────────
  const filteredRuns = useMemo(() => {
    let list = runs;
    if (filter !== "all") {
      list = list.filter((r) => {
        if (filter === "running") return r.status === "running" || r.status === "pending";
        return r.status === filter;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.leadName?.toLowerCase().includes(q) ||
          r.leadEmail?.toLowerCase().includes(q) ||
          String(r.id).includes(q)
      );
    }
    return list;
  }, [runs, filter, search]);

  const counts = useMemo(() => ({
    all: runs.length,
    running: runs.filter((r) => r.status === "running" || r.status === "pending").length,
    completed: runs.filter((r) => r.status === "completed").length,
    failed: runs.filter((r) => r.status === "failed").length,
  }), [runs]);

  const handleEnrichHandle = useCallback((platform: EnrichmentPlatform, identifier: string) => {
    enrichHandleMutation.mutate({ platform, identifier });
  }, [enrichHandleMutation]);

  const handleEnrichLead = useCallback((leadId: number) => {
    enrichLeadMutation.mutate(leadId);
  }, [enrichLeadMutation]);

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex min-h-[calc(100dvh-64px)] bg-background lg:h-[calc(100dvh-64px)]">
      {/* ── SIDEBAR ──────────────────────────────────────────── */}
      <aside className={cn(
        "w-full border-border bg-card/60 backdrop-blur-xl lg:w-80 lg:border-r",
        selectedRunId ? "hidden lg:flex lg:flex-col" : "flex min-h-[calc(100dvh-64px)] flex-col"
      )} aria-label="Enrichment runs">
        <div className="p-4 border-b border-border">
          <div className="mb-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-semibold text-foreground/90">Lead Enrichment</h1>
              <p className="text-xs text-muted-foreground">{runs.length} enrichment runs</p>
            </div>
            <Button
              size="sm"
              data-enrichment-opener
              onClick={event => { newDialogOpener.current = event.currentTarget; setNewDialogOpen(true); }}
              className="border-0 bg-gradient-to-r from-violet-600 to-purple-600 text-xs text-white hover:from-violet-500 hover:to-purple-500 lg:hidden"
              aria-label="New enrichment"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              New
            </Button>
          </div>

          <SearchInput
            size="sm"
            value={search}
            onValueChange={setSearch}
            placeholder="Search enrichments..."
            aria-label="Search enrichment runs"
            className="bg-muted/40 border-border text-foreground text-sm focus-visible:ring-violet-500/20"
          />
        </div>

        <div className="flex gap-1.5 px-4 py-2.5 border-b border-border">
          {(["all", "running", "completed", "failed"] as FilterStatus[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium transition-all capitalize",
                filter === f
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground/60 hover:bg-muted/30"
              )}
            >
              {f} {counts[f] > 0 && <span className="ml-0.5 opacity-60">{counts[f]}</span>}
            </button>
          ))}
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {runsLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl">
                  <Skeleton className="w-10 h-10 rounded-2xl bg-muted/40" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-24 bg-muted/40" />
                    <Skeleton className="h-2.5 w-16 bg-muted/40" />
                  </div>
                </div>
              ))
            ) : runsError ? (
              <div className="px-4 py-10 text-center">
                <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
                <p className="text-sm font-medium text-foreground">Enrichment history unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">Check your connection and try again.</p>
                <Button className="mt-4" size="sm" variant="outline" onClick={() => { void refetchRuns(); }}>
                  <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            ) : filteredRuns.length === 0 ? (
              <div className="text-center py-8 px-3">
                {runs.length === 0 ? (
                  <>
                    <Database className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                    <p className="text-xs font-medium text-muted-foreground/70 mb-0.5">No enrichment history yet</p>
                    <p className="text-xs text-muted-foreground/50">Click <strong>+ New Enrichment</strong> above to get started</p>
                  </>
                ) : (
                  <>
                    <Search className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                    <p className="text-xs font-medium text-muted-foreground/70 mb-0.5">No results match your search</p>
                    <p className="text-xs text-muted-foreground/50">Try a different name, email, or run ID</p>
                  </>
                )}
              </div>
            ) : (
              filteredRuns.map((run) => {
                const isActive = selectedRunId === run.id;
                const label = run.leadName || `Run #${run.id}`;
                const emails = run.emailsFound || 0;
                const phones = run.phonesFound || 0;
                const websites = run.websitesFound || 0;
                const totalFound = emails + phones + websites;
                const summaryPlatforms = (run.summary as Record<string, unknown>)?.socialProfiles;
                const displayPlatform = Array.isArray(summaryPlatforms) && summaryPlatforms.length > 0
                  ? summaryPlatforms[0]
                  : null;
                const PlatIcon = getPlatformIcon(displayPlatform);

                return (
                  <button
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    className={cn(
                      "w-full flex items-center gap-3 p-3 rounded-xl transition-all text-left group",
                      isActive
                        ? "bg-violet-500/15 border border-violet-500/20"
                        : "hover:bg-muted/30 border border-transparent"
                    )}
                  >
                    <div className="relative">
                      <Avatar className="w-10 h-10 rounded-2xl">
                        <AvatarFallback className={cn(
                          "rounded-2xl bg-gradient-to-br text-white text-xs font-medium",
                          getPlatformColor(displayPlatform)
                        )}>
                          <PlatIcon className="w-4 h-4" />
                        </AvatarFallback>
                      </Avatar>
                      <div className={cn(
                        "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background",
                        getStatusColor(run.status),
                        (run.status === "running" || run.status === "pending") && "animate-pulse"
                      )} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-foreground/90 truncate">{label}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {maskEmail(run.leadEmail) || `${run.totalIterations || 0} iterations`}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        {totalFound > 0 && (
                          <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                            {emails > 0 && <><Mail className="w-3 h-3" />{emails}</>}
                            {phones > 0 && <><Phone className="w-3 h-3 ml-1" />{phones}</>}
                            {websites > 0 && <><Globe className="w-3 h-3 ml-1" />{websites}</>}
                          </span>
                        )}
                            {/* The avatar dot is colour-only; say the status in text too. */}
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {RUN_STATUS_LABELS[run.status] ?? run.status}<span aria-hidden="true"> · </span>{formatTime(run.createdAt)}
                            </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* ── MAIN AREA ────────────────────────────────────────── */}
      <div className={cn(
        "min-w-0 flex-1 flex-col",
        selectedRunId ? "flex min-h-[calc(100dvh-64px)]" : "hidden lg:flex"
      )}>
        <div className="h-14 border-b border-border flex items-center justify-between px-4 bg-card/40 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-violet-500" />
            <span className="text-sm font-medium text-foreground/70">Enrichment Activity</span>
            {liveProgress && (
              <Badge variant="outline" className="ml-2 border-blue-500/20 bg-blue-500/10 text-[10px] text-blue-700 dark:text-blue-300">
                <Activity className="w-3 h-3 mr-1 animate-pulse" /> Live
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetchRuns()}
              aria-label="Refresh enrichment runs"
              className="text-muted-foreground hover:text-foreground/70 hover:bg-muted/40"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              data-enrichment-opener
              onClick={event => { newDialogOpener.current = event.currentTarget; setNewDialogOpen(true); }}
              className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white border-0 text-xs"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              New Enrichment
            </Button>
          </div>
        </div>

        {!selectedRunId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-violet-500/20 to-purple-600/20 flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-10 h-10 text-violet-400/60" />
              </div>
              <h3 className="text-lg font-medium text-foreground/70 mb-1">No enrichment selected</h3>
              <p className="text-sm text-muted-foreground/60 max-w-xs">
                Select an enrichment from the sidebar or start a new one to view details.
              </p>
            </div>
          </div>
        ) : detailLoading ? (
          <LoadingState className="flex-1" label="Loading enrichment details…" />
        ) : detailError ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <div>
              <AlertCircle className="mx-auto mb-3 h-9 w-9 text-destructive" />
              <h3 className="font-semibold text-foreground">Enrichment details unavailable</h3>
              <p className="mt-1 text-sm text-muted-foreground">This run could not be retrieved.</p>
              <Button className="mt-4" variant="outline" onClick={() => { void refetchDetail(); }}>Try again</Button>
            </div>
          </div>
        ) : selectedRun ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-6 py-4 border-b border-border bg-card/20">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setSelectedRunId(null)}
                  aria-label="Back to enrichment runs"
                  className="w-8 h-8 rounded-xl bg-muted/40 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground/70 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <Avatar className="w-11 h-11 rounded-2xl">
                  <AvatarFallback className={cn(
                    "rounded-2xl bg-gradient-to-br text-white font-medium",
                    "from-violet-500 to-purple-600"
                  )}>
                    {getInitials(selectedRun.leadName)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-foreground/90 truncate">
                      {selectedRun.leadName || `Run #${selectedRun.id}`}
                    </h3>
                    <RunStatusBadge status={selectedRun.status} stale={staleActivity} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                    {selectedRun.leadEmail && <span>{selectedRun.leadEmail}</span>}
                    {selectedRun.totalIterations != null && selectedRun.totalIterations > 0 && (
                      <span>· {selectedRun.totalIterations} iterations</span>
                    )}
                    {selectedRun.totalHandlesProcessed != null && selectedRun.totalHandlesProcessed > 0 && (
                      <span>· {selectedRun.totalHandlesProcessed} handles</span>
                    )}
                    <span>· {formatTimeDiff(selectedRun.startedAt, selectedRun.completedAt) || "starting..."}</span>
                  </p>
                </div>
              </div>
            </div>

            <AnimatePresence>
              {!staleActivity && selectedRun.status === "running" && liveProgress && ['started', 'progress'].includes(liveProgress.status) && (
                <LiveProgressBanner progress={liveProgress} />
              )}
            </AnimatePresence>

            <ScrollArea className="flex-1 px-6" ref={detailScrollRef}>
              <div className="py-6 flex flex-col gap-4">
                <div className="text-center">
                  <span className="text-xs text-muted-foreground/40 bg-muted/30 px-3 py-1 rounded-full">
                    Enrichment started {formatTime(selectedRun.startedAt || selectedRun.createdAt)}
                  </span>
                </div>

                {selectedRun.steps?.map((step, i) => (
                  <StepBubble key={step.id} step={step} index={i} stale={staleActivity} />
                ))}

                {staleActivity && <div role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm">
                  No recent enrichment activity has been recorded. The saved status is {selectedRun.status}; this does not confirm the worker is still active.
                  <Button variant="outline" className="mt-3 block" onClick={() => refetchDetail()}>Refresh enrichment status</Button>
                </div>}
                {awaitingTerminalRefresh && <div role="status" className="rounded-xl border p-4 text-sm">
                  {liveProgress?.status === 'failed' ? 'Enrichment reported a failure. Refreshing saved status…' : 'Enrichment finished. Refreshing saved results…'}
                  <Button variant="outline" className="mt-3 block" onClick={() => refetchDetail()}>Refresh result details</Button>
                </div>}
                {!staleActivity && !awaitingTerminalRefresh && (selectedRun.status === "pending" || (selectedRun.status === "running" && !liveProgress)) && (
                  <div className="text-center">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs text-blue-700 dark:text-blue-300">
                      <Spinner size="xs" label={null} /> {selectedRun.status === 'pending' ? 'Queued for enrichment...' : 'Processing...'}
                    </span>
                  </div>
                )}
                {selectedRun.status === "completed" && (
                  <>
                    <div className="text-center">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="w-3 h-3" /> Enrichment complete
                      </span>
                    </div>
                    <EnrichmentResultsPanel run={selectedRun} />
                  </>
                )}
                {selectedRun.status === "failed" && (
                  <div className="text-center">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-3 py-1 text-xs text-red-700 dark:text-red-300">
                      <XCircle className="w-3 h-3" /> {selectedRun.errorMessage || "Enrichment failed"}
                    </span>
                  </div>
                )}
                {selectedRun.billingStatus === "held" && (
                  <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                    This enrichment outcome needs review. Its reserved fixed-fee credits are still held. Review this run before starting another request.
                  </p>
                )}
              </div>
            </ScrollArea>

            {selectedRun.status === "completed" && (
              <div className="px-6 py-3 border-t border-border bg-card/40 flex items-center gap-4">
                <span className="text-xs text-muted-foreground/60 uppercase tracking-wider font-medium">Found</span>
                {(selectedRun.emailsFound || 0) > 0 && (
                  <Badge variant="outline" className="border-blue-500/20 bg-blue-500/10 text-xs text-blue-700 dark:text-blue-300">
                    <Mail className="w-3 h-3 mr-1" /> {selectedRun.emailsFound} emails
                  </Badge>
                )}
                {(selectedRun.phonesFound || 0) > 0 && (
                  <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300">
                    <Phone className="w-3 h-3 mr-1" /> {selectedRun.phonesFound} phones
                  </Badge>
                )}
                {(selectedRun.websitesFound || 0) > 0 && (
                  <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
                    <Globe className="w-3 h-3 mr-1" /> {selectedRun.websitesFound} websites
                  </Badge>
                )}
                {selectedRun.totalHandlesProcessed != null && selectedRun.totalHandlesProcessed > 0 && (
                  <Badge variant="outline" className="border-purple-500/20 bg-purple-500/10 text-xs text-purple-700 dark:text-purple-300">
                    <User className="w-3 h-3 mr-1" /> {selectedRun.totalHandlesProcessed} handles
                  </Badge>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <NewEnrichmentDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onReturnFocus={() => {
          const opener = newDialogOpener.current;
          if (opener?.isConnected) opener.focus();
          if (document.activeElement !== opener) {
            Array.from(document.querySelectorAll<HTMLButtonElement>('[data-enrichment-opener]'))
              .find(button => button.getClientRects().length > 0)?.focus();
          }
        }}
        onEnrichHandle={handleEnrichHandle}
        onEnrichLead={handleEnrichLead}
        isSubmitting={enrichHandleMutation.isPending || enrichLeadMutation.isPending}
      />
    </div>
  );
}
