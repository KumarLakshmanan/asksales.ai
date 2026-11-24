"use client";

import Link from "next/link";
import type { DashboardReporting } from "../../../../../../shared/dashboardReporting";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { BarChart3, Users, TrendingUp, Mail, MessageSquare, Globe, Linkedin, Target, Zap, ArrowUpRight, ArrowDownRight, Calendar, Activity, Mic, Send, MessageCircle, LayoutDashboard, Clock, FileText, Megaphone } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { useSetupComplete } from "@/hooks/useSetupComplete";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from '@/lib/api';
import { WorkspaceNextSteps } from "@/components/WorkspaceNextSteps";
import { DashboardStats } from "./_components/DashboardStats";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface AgentRunThread {
  id: number;
  title: string;
  selectedAgent: string | null;
  createdAt: string;
  updatedAt: string;
  business?: {
    id: number;
    name: string;
    industry: string | null;
  } | null;
  icp?: {
    id: number;
    campaignName: string | null;
    targetAudience: string | null;
    industry: string | null;
    fitScore: number | null;
  } | null;
  stats: {
    leadsCount: number;
    contentCount: number;
    outreachCount: number;
    adCopyCount: number;
    imageCount: number;
    videoCount: number;
  };
}

interface DashboardStats extends DashboardReporting {
  totalLeads: number;
  newLeads: number;
  activeCampaigns: number;
  completedCampaigns: number;
  totalSpent: number | null;
  totalBudget: number | null;
  currency?: string | null;
  spendByCurrency?: Record<string,number>;
  budgetByCurrencyAndType?: Array<{currency:string;type:string;amount:number}>;
  messagesSent: number;
  conversionRate: string | null;
  // Channel performance data
  channelPerformance?: {
    email: { sent: number; opened: number; clicked: number; replied: number };
    sms: { sent: number; delivered: number; replied: number };
    linkedin: { sent: number; accepted: number; replied: number };
  };
  // Lead source data
  leadSources?: {
    source: string;
    count: number;
    percentage: number;
  }[];
  // Weekly trends
  weeklyTrends?: {
    leadsThisWeek: number;
    leadsLastWeek: number;
    messagesThisWeek: number;
    messagesLastWeek: number;
    customerUpdatesThisWeek: number;
    customerUpdatesLastWeek: number;
  };

}

// Chart colors — sourced from CSS custom properties so they adapt to theme/dark mode
const CHART_COLORS = {
  primary: "hsl(258 72% 65%)",
  secondary: "hsl(268 73% 75%)",
  tertiary: "hsl(340 80% 82%)",
  quaternary: "hsl(345 70% 90%)",
  success: "hsl(142 71% 45%)",
  warning: "hsl(45 93% 47%)",
  info: "hsl(217 91% 60%)",
};

const PIE_COLORS = [
  "hsl(258 72% 65%)",
  "hsl(268 73% 75%)",
  "hsl(340 80% 82%)",
  "hsl(345 70% 90%)",
  "hsl(330 60% 62%)",
];

export default function DashboardHome() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { hasBusinessProfile } = useSetupComplete();
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [chatHistoryError, setChatHistoryError] = useState<string | null>(null);
  const [recentRunsError, setRecentRunsError] = useState<string | null>(null);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [allSuggestions, setAllSuggestions] = useState<string[]>([]);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "dashboard">("chat");
  const [hasChats, setHasChats] = useState<boolean | null>(null);
  const [recentRuns, setRecentRuns] = useState<AgentRunThread[]>([]);
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [isCreatingThread, setIsCreatingThread] = useState(false);

  const { profiles: businessProfiles, activeProfile, error: businessProfilesError, refetch: refetchBusinessProfiles, switchProfile } = useBusinessProfiles();
  const selectedBusinessProfileId = activeProfile ? String(activeProfile.id) : "";
  const handleBusinessProfileChange = async (value: string) => {
    try {
      await switchProfile(Number(value));
    } catch (error) {
      toast({ title: "Could not switch business profile", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    }
  };

  const recognitionRef = useRef<{ abort: () => void } | null>(null);
  const cancelRecognition = useCallback(() => {
    const current = recognitionRef.current;
    recognitionRef.current = null;
    try { current?.abort(); } catch { /* Already ended. */ }
  }, []);

  useEffect(() => () => cancelRecognition(), [cancelRecognition, activeTab, selectedBusinessProfileId]);

  // Voice recognition handler
  const handleMicClick = useCallback(() => {
    if (recognitionRef.current) {
      cancelRecognition();
      setIsListening(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      toast({
        title: "Not Supported",
        description: "Voice recognition is not supported in this browser. Please use Chrome or Edge.",
        variant: "destructive",
      });
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      setIsListening(true);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      if (recognitionRef.current !== recognition) return;
      // Use the latest result (in case the event contains multiple results)
      const lastResult = event.results[event.results.length - 1];
      const rawTranscript = (lastResult && lastResult[0] && lastResult[0].transcript) || "";

      // Normalize transcript: collapse repeated consecutive words (e.g., "Hello Hello Hello" -> "Hello")
      const compressRepeatedWords = (text: string) => {
        const parts = text.trim().split(/\s+/);
        const out: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          if (i === 0 || parts[i].toLowerCase() !== parts[i - 1].toLowerCase()) {
            out.push(parts[i]);
          }
        }
        return out.join(" ");
      };

      const transcript = compressRepeatedWords(rawTranscript);
      setInputValue((prev: string) => (prev ? prev + " " + transcript : transcript));
      cancelRecognition();
      setIsListening(false);
    };

    recognition.onerror = () => {
      if (recognitionRef.current !== recognition) return;
      cancelRecognition();
      setIsListening(false);
      toast({
        title: "Voice Error",
        description: "Failed to recognize speech. Please try again.",
        variant: "destructive",
      });
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setIsListening(false);
    };

    try {
      setIsListening(true);
      recognition.start();
    } catch {
      cancelRecognition();
      setIsListening(false);
      toast({ title: "Voice Error", description: "Voice input could not start. Please check microphone permissions and try again.", variant: "destructive" });
    }
  }, [toast, cancelRecognition]);

  // Fetch personalized suggestions
  const fetchSuggestions = useCallback(async () => {
    try {
      setIsFetchingSuggestions(true);
      setSuggestionsError(null);
      const data = await api.get<{ success: boolean; suggestions: string[]; allSuggestions?: string[] }>("/api/suggestions");
      if (data.success && data.suggestions) {
        setSuggestions(data.suggestions);
        setAllSuggestions(data.allSuggestions || data.suggestions || []);
      }
    } catch (error: unknown) {
      setSuggestionsError(error instanceof Error ? error.message : "Suggestions could not be loaded.");
    } finally {
      setIsFetchingSuggestions(false);
    }
  }, []);

  // Helper: create a chat thread via API, store original message, then navigate
  const createThreadAndNavigate = useCallback(async (message: string) => {
    if (isCreatingThread) return;
    setIsCreatingThread(true);
    try {
      const body: Record<string, unknown> = { title: message.slice(0, 80) };
      if (selectedBusinessProfileId) body.businessProfileId = Number(selectedBusinessProfileId);
      const thread = await api.post<{ id: number }>('/api/chat/threads', body);
      if (thread && thread.id) {
        sessionStorage.setItem('chat_initial_message', message);
        router.push(`/dashboard/conversations/${thread.id}`);
      } else {
        throw new Error("The conversation was not created. Please try again.");
      }
    } catch (error: unknown) {
      toast({ title: "Conversation could not be started", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setIsCreatingThread(false);
    }
  }, [isCreatingThread, router, selectedBusinessProfileId, toast]);

  // Handle input submission - create thread and navigate to chat
  const handleSubmit = useCallback(() => {
    if (!inputValue.trim()) return;
    createThreadAndNavigate(inputValue.trim());
  }, [inputValue, createThreadAndNavigate]);

  // Handle suggestion click - create thread and navigate to chat
  const handleSuggestionClick = useCallback((suggestion: string) => {
    createThreadAndNavigate(suggestion);
  }, [createThreadAndNavigate]);

  // Handle keyboard submit
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const fetchDashboardStats = useCallback(async () => {
    try {
      setIsLoading(true);
      setDashboardError(null);
      const data = await api.get<DashboardStats>("/api/dashboard/stats");
      setStats(data);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to fetch dashboard stats";
      setDashboardError(message);
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchDashboardStats();
    fetchSuggestions();
  }, [fetchDashboardStats, fetchSuggestions]);

  // Check if user has previous chat threads to determine default tab.
  // Only existence matters here, so request the compact list: the full list
  // computes per-thread lead, outreach and asset counts and is far heavier.
  const checkChatHistory = useCallback(async () => {
    try {
      setChatHistoryError(null);
      if (!activeProfile) return;
      const data = await api.get<unknown>(`/api/chat/threads?limit=1&view=compact&businessProfileId=${activeProfile.id}`);
      const threads = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.threads || []) as unknown[];
      const userHasChats = threads.length > 0;
      setHasChats(userHasChats);
      // Default: if user has chats, show chat tab; otherwise show dashboard
      setActiveTab(userHasChats ? "chat" : "dashboard");
    } catch (error: unknown) {
      setChatHistoryError(error instanceof Error ? error.message : "Conversation history could not be checked.");
      setHasChats(false);
      setActiveTab("chat");
    }
  }, [activeProfile]);

  useEffect(() => { void checkChatHistory(); }, [checkChatHistory]);

  // Fetch recent agent runs (chat threads with stats) for the dashboard tab
  const fetchRecentRuns = useCallback(async () => {
    try {
      setIsLoadingRuns(true);
      setRecentRunsError(null);
      if (!activeProfile) return;
      const response = await api.get<{ threads: AgentRunThread[]; total: number }>(`/api/chat/threads?limit=6&offset=0&businessProfileId=${activeProfile.id}`);
      setRecentRuns(response?.threads || []);
    } catch (error: unknown) {
      setRecentRunsError(error instanceof Error ? error.message : "Recent agent runs could not be loaded.");
    } finally {
      setIsLoadingRuns(false);
    }
  }, [activeProfile]);

  // The full thread list (with per-thread counts) is the heaviest request on
  // this page and is only shown on the Performance tab. Load it when that tab
  // is first opened for a profile instead of on every home visit.
  const recentRunsProfileRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeTab !== "dashboard" || !activeProfile || recentRunsProfileRef.current === activeProfile.id) return;
    recentRunsProfileRef.current = activeProfile.id;
    void fetchRecentRuns();
  }, [activeTab, activeProfile, fetchRecentRuns]);

  // Helper to format agent name
  const formatAgentName = (agent: string | null) => {
    if (!agent) return "AskSales.AI";
    return agent.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  // Helper to get agent badge variant
  const getAgentBadgeVariant = (agent: string | null): "default" | "secondary" | "outline" | "destructive" => {
    if (!agent) return "secondary";
    switch (agent.toLowerCase()) {
      case "lead_generation":
      case "lead-generation":
        return "default";
      case "content_studio":
      case "content-studio":
        return "secondary";
      case "outreach":
        return "destructive";
      default:
        return "outline";
    }
  };

  // Helper to format date
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays === 0) {
      return `Today at ${date.toLocaleTimeString("en-IN", { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`;
    } else if (diffDays === 1) {
      return `Yesterday`;
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString("en-IN", { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
    }
  };

  // Use actual daily activity data or empty array
  const dailyActivityData = stats?.dailyActivity || [];

  // Channel comparison data for bar chart - only use actual data
  const channelComparisonData = [
    {
      channel: "Email",
      sent: stats?.channelPerformance?.email?.sent || 0,
      replied: stats?.channelPerformance?.email?.replied || 0,
    },
    {
      channel: "SMS",
      sent: stats?.channelPerformance?.sms?.sent || 0,
      replied: stats?.channelPerformance?.sms?.replied || 0,
    },
    {
      channel: "LinkedIn",
      sent: stats?.channelPerformance?.linkedin?.sent || 0,
      replied: stats?.channelPerformance?.linkedin?.replied || 0,
    },
  ];

  // Pie chart data for lead sources - only use actual data
  const leadSourcePieData = stats?.leadSources?.map((source) => ({
    name: source.source,
    value: source.count,
  })) || [];

  // Campaign performance data - only use actual data
  const campaignPerformanceData = stats?.campaignPerformance || [];

  // Check if we have any real data
  const hasChannelData = channelComparisonData.some(c => c.sent > 0 || c.replied > 0);
  const hasLeadSourceData = leadSourcePieData.length > 0;
  const hasCampaignData = campaignPerformanceData.length > 0;
  const hasDailyActivityData = dailyActivityData.some(day => day.leads > 0 || day.messages > 0 || day.customerUpdates > 0);

  // Show loading state while checking chat history
  if (isLoading && hasChats === null) {
    return (
      <LoadingState size="page" label="Loading your workspace…" />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4 px-4 py-6 sm:px-6 lg:px-10 xl:py-8">
      {/* Header with Tab Switcher */}
      <div className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
            {activeTab === "chat" ? "New work" : "Workspace overview"}
          </p>
          <h1 className="text-xl font-semibold tracking-[-0.03em] text-foreground sm:text-[1.75rem]">
            {activeTab === "chat" ? (
              <>Start with the outcome.</>
            ) : (
              <>Welcome back, {user?.name}.</>
            )}
          </h1>
          <p className="mt-1.5 max-w-[60ch] text-sm leading-5 text-muted-foreground">
            {activeTab === "chat"
              ? "Describe the result you need. AskSales.AI will plan the work, show every approval, and keep the receipts."
              : "Review real activity across leads, outreach, content, and advertising."}
          </p>
        </div>

        {/* Tab Bar Switch */}
        <div className="flex items-center rounded-[10px] border border-border bg-muted/50 p-1" aria-label="Home view">
          <button
            type="button"
            aria-pressed={activeTab === "chat"}
            onClick={() => { cancelRecognition(); setIsListening(false); setActiveTab("chat"); }}
            className={`flex min-h-9 items-center gap-2 rounded-[7px] px-3.5 text-sm font-semibold transition-colors ${
              activeTab === "chat"
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessageCircle className="h-3.5 w-3.5" />
            Brief an agent
          </button>
          <button
            type="button"
            aria-pressed={activeTab === "dashboard"}
            onClick={() => { cancelRecognition(); setIsListening(false); setActiveTab("dashboard"); }}
            className={`flex min-h-9 items-center gap-2 rounded-[7px] px-3.5 text-sm font-semibold transition-colors ${
              activeTab === "dashboard"
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            Performance
          </button>
        </div>
      </div>

      {activeProfile && <WorkspaceNextSteps key={activeProfile.id} profile={activeProfile} />}

      {chatHistoryError && <Alert variant="destructive"><AlertTitle>Conversation history could not be checked</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{chatHistoryError}</span><Button variant="outline" size="sm" onClick={() => void checkChatHistory()}>Try again</Button></AlertDescription></Alert>}

      {/* Chat Tab Content */}
      {activeTab === "chat" && (
        <div className="grid min-h-[560px] gap-10 xl:grid-cols-[minmax(0,1fr)_280px] xl:gap-14">
          <div className="min-w-0">
            {businessProfilesError && <Alert variant="destructive" className="mb-6 text-left"><AlertTitle>Business profiles could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{businessProfilesError instanceof Error ? businessProfilesError.message : "Profile selection is temporarily unavailable."}</span><Button variant="outline" size="sm" onClick={() => void refetchBusinessProfiles()}>Try again</Button></AlertDescription></Alert>}

            <div className="border-t-2 border-primary bg-card px-5 py-5 shadow-sm ring-1 ring-border sm:px-6">
              <label htmlFor="agent-brief" className="text-sm font-semibold text-foreground">What should the team accomplish?</label>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Include the audience, channel, volume, timing, or success criteria you already know.</p>
              <div className="group relative mt-4">
                <textarea
                  id="agent-brief"
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isCreatingThread}
                  rows={4}
                  className="block w-full resize-none rounded-[12px] border border-input bg-background px-4 py-3 pr-14 text-[15px] leading-6 shadow-inner outline-none placeholder:text-muted-foreground/80 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
                  placeholder="For example: Find finance leaders at Indian SaaS companies, save qualified contacts, then draft a two-step email sequence for my review."
                />
                <button
                  type="button"
                  onClick={handleMicClick}
                  aria-label={isListening ? "Stop voice input" : "Start voice input"}
                  aria-pressed={isListening}
                  className={`absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-[9px] transition-colors ${
                    isListening ? "bg-destructive/10 text-destructive" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Mic className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p id="agent-brief-hint" className="text-xs leading-5 text-muted-foreground">
                  {inputValue.trim()
                    ? "You will review any action that sends, publishes, or spends."
                    : <><span className="font-medium text-foreground">Describe the outcome to enable planning.</span> You will review any action that sends, publishes, or spends.</>}
                </p>
                <Button onClick={handleSubmit} disabled={!inputValue.trim()} loading={isCreatingThread} loadingText="Starting…" className="sm:min-w-36" aria-describedby="agent-brief-hint">
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Plan this work
                </Button>
              </div>
            </div>

            {hasBusinessProfile && (
              <section className="mt-4" aria-labelledby="quick-starts-heading">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <div>
                    <h2 id="quick-starts-heading" className="text-sm font-semibold">Quick starts</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">Use a real task as a starting point, then edit it before running.</p>
                  </div>
                  {isFetchingSuggestions && <span className="text-xs text-muted-foreground">Loading…</span>}
                </div>
                {suggestionsError && <Alert variant="destructive" className="mb-4 text-left"><AlertTitle>Quick starts could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{suggestionsError}</span><Button variant="outline" size="sm" onClick={() => void fetchSuggestions()}>Try again</Button></AlertDescription></Alert>}
                {!isFetchingSuggestions && (() => {
                  const items = Array.from(new Set(allSuggestions.length > 0 ? allSuggestions : suggestions)).slice(0, 6);
                  if (items.length === 0) return null;
                  return (
                    <div className="grid gap-px overflow-hidden rounded-[12px] border border-border bg-border sm:grid-cols-2">
                      {items.map((suggestion) => (
                        <button
                          type="button"
                          key={suggestion}
                          onClick={() => handleSuggestionClick(suggestion)}
                          className="group flex min-h-20 items-start justify-between gap-4 bg-card px-4 py-3.5 text-left text-sm leading-5 text-foreground transition-colors hover:bg-muted/65 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <span className="line-clamp-3">{suggestion}</span>
                          <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </section>
            )}
          </div>

          <aside className="border-t border-border pt-5 xl:border-l xl:border-t-0 xl:pl-7 xl:pt-1" aria-label="Work context">
            {businessProfiles.length > 1 && (
              <div className="border-b border-border pb-6">
                <label className="text-xs font-semibold text-foreground">Business profile</label>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Sets the brand, market, and account context.</p>
                <Select value={selectedBusinessProfileId} onValueChange={(value) => void handleBusinessProfileChange(value)}>
                  <SelectTrigger className="mt-3 h-10 w-full rounded-[10px] bg-card text-sm">
                    <SelectValue placeholder="Select a profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {businessProfiles.map((profile) => (
                      <SelectItem key={profile.id} value={String(profile.id)}>{profile.name || profile.companyName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className={businessProfiles.length > 1 ? "pt-6" : ""}>
              <h2 className="text-sm font-semibold">How the work moves</h2>
              <ol className="mt-5 space-y-0">
                {[
                  ["Brief", "State the outcome and constraints."],
                  ["Review", "Inspect the plan and consequential actions."],
                  ["Run", "Follow progress, results, and provider receipts."],
                ].map(([label, description], index) => (
                  <li key={label} className="relative grid grid-cols-[24px_1fr] gap-3 pb-6 last:pb-0">
                    {index < 2 && <span className="absolute left-[11px] top-6 h-[calc(100%-8px)] w-px bg-border" aria-hidden="true" />}
                    <span className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background font-mono text-[10px] font-semibold text-muted-foreground">{index + 1}</span>
                    <span>
                      <span className="block text-sm font-semibold text-foreground">{label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        </div>
      )}

      {/* Dashboard Tab Content */}
      {activeTab === "dashboard" && (
        dashboardError ? (
          <Alert variant="destructive"><AlertTitle>Dashboard analytics could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{dashboardError}</span><Button variant="outline" size="sm" onClick={() => void fetchDashboardStats()}>Try again</Button></AlertDescription></Alert>
        ) : <>
      {/* Stats Grid */}
      <DashboardStats stats={stats} isLoading={isLoading} />
      {stats?.recordedWins?.coverage === "restricted" && <p className="text-sm text-muted-foreground">CRM reporting is unavailable without CRM module access.</p>}
      <p className="text-sm text-muted-foreground">CRM win rate uses recorded first lifetime wins divided by canonical CRM contacts, including archived contacts. Merged contacts count once. Historical wins without recorded activity are unavailable; reopening does not create a second first win.</p>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Start a new campaign or manage existing ones</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-4">
          <Link href="/dashboard/conversations">
            <Button className="bg-primary hover:bg-primary/90">
              Start New Campaign
            </Button>
          </Link>
          <Link href="/dashboard/chats">
            <Button variant="outline">View All Campaigns</Button>
          </Link>
        </CardContent>
      </Card>

      {/* Recent Agent Runs & History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Recent Agent Runs
              </CardTitle>
              <CardDescription>Latest campaigns and agent activity</CardDescription>
            </div>
            <Link href="/dashboard/chats">
              <Button variant="outline" size="sm">View All</Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {recentRunsError ? (
            <Alert variant="destructive"><AlertTitle>Recent agent runs could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{recentRunsError}</span><Button variant="outline" size="sm" onClick={() => void fetchRecentRuns()}>Try again</Button></AlertDescription></Alert>
          ) : isLoadingRuns ? (
            <LoadingState className="py-8" label="Loading recent agent runs…" />
          ) : recentRuns.length > 0 ? (
            <div className="space-y-3">
              {recentRuns.map((run) => (
                <Link
                  key={run.id}
                  href={`/dashboard/conversations/${run.id}`}
                  className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-muted/50 hover:shadow-sm transition-all cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex-wrap gap-y-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center flex-shrink-0">
                      <MessageSquare className="h-4 w-4 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {run.icp?.campaignName || run.title || `Campaign ${run.id}`}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 mt-0.5">
                        <Badge variant={getAgentBadgeVariant(run.selectedAgent)} className="text-xs py-0 px-1.5">
                          {formatAgentName(run.selectedAgent)}
                        </Badge>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDate(run.updatedAt || run.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                    {run.icp?.fitScore != null && run.icp.fitScore > 0 && (
                      <Badge
                        variant="secondary"
                        className={`text-xs py-0 px-1.5 ${
                          run.icp.fitScore >= 70
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                            : run.icp.fitScore >= 50
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                            : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                        }`}
                      >
                        ICP {run.icp.fitScore}%
                      </Badge>
                    )}
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <div className="flex items-center gap-1" title="Leads">
                        <Users className="h-3.5 w-3.5 text-purple-600" />
                        <span className="text-xs font-medium">{run.stats?.leadsCount || 0}</span>
                      </div>
                      <div className="flex items-center gap-1" title="Content">
                        <FileText className="h-3.5 w-3.5 text-blue-600" />
                        <span className="text-xs font-medium">{run.stats?.contentCount || 0}</span>
                      </div>
                      <div className="flex items-center gap-1" title="Ad Copies">
                        <Megaphone className="h-3.5 w-3.5 text-orange-600" />
                        <span className="text-xs font-medium">{run.stats?.adCopyCount || 0}</span>
                      </div>
                      <div className="flex items-center gap-1" title="Outreach">
                        <Send className="h-3.5 w-3.5 text-green-600" />
                        <span className="text-xs font-medium">{run.stats?.outreachCount || 0}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm">No agent runs yet.</p>
              <p className="text-xs mt-1">Start a new campaign to see agent activity here.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Charts Section - Activity Overview & Lead Sources */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        {/* Daily Activity Area Chart */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Daily Activity Overview
            </CardTitle>
            <CardDescription>Leads, recorded outbound messages, and first CRM wins over 7 UTC days</CardDescription>
          </CardHeader>
          <CardContent>
            {hasDailyActivityData ? (
              <div className="h-[300px]" role="img" aria-label="Daily activity chart: leads, recorded outbound messages, and first CRM wins over 7 UTC days">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dailyActivityData}>
                    <defs>
                      <linearGradient id="colorLeads" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.8} />
                        <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0.1} />
                      </linearGradient>
                      <linearGradient id="colorMessages" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.info} stopOpacity={0.8} />
                        <stop offset="95%" stopColor={CHART_COLORS.info} stopOpacity={0.1} />
                      </linearGradient>
                      <linearGradient id="colorConversions" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.success} stopOpacity={0.8} />
                        <stop offset="95%" stopColor={CHART_COLORS.success} stopOpacity={0.1} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                        color: 'hsl(var(--foreground))'
                      }}
                    />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="leads"
                      stroke={CHART_COLORS.primary}
                      fillOpacity={1}
                      fill="url(#colorLeads)"
                      name="Leads"
                    />
                    <Area
                      type="monotone"
                      dataKey="messages"
                      stroke={CHART_COLORS.info}
                      fillOpacity={1}
                      fill="url(#colorMessages)"
                      name="Messages"
                    />
                    <Area
                      type="monotone"
                      dataKey="recordedWins"
                      stroke={CHART_COLORS.success}
                      fillOpacity={1}
                      fill="url(#colorConversions)"
                      name="Recorded first CRM wins"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <Activity className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No activity data available yet.</p>
                  <p className="text-xs mt-1">Start campaigns to see your daily activity.</p>
                </div>
              </div>
            )}
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium">View daily activity values</summary>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs" aria-label="Daily activity values">
                  <thead><tr><th scope="col">UTC date</th><th scope="col">Leads</th><th scope="col">Messages</th><th scope="col">Recorded first CRM wins</th><th scope="col">Customer record updates</th></tr></thead>
                  <tbody>{dailyActivityData.map(day => <tr key={day.date}><th scope="row" className="py-2 font-normal">{day.date}</th><td>{day.leads}</td><td>{day.messages}</td><td>{day.recordedWins ?? "—"}</td><td>{day.customerUpdates}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          </CardContent>
        </Card>

        {/* Lead Sources Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Lead Sources
            </CardTitle>
            <CardDescription>Distribution by platform</CardDescription>
          </CardHeader>
          <CardContent>
            {hasLeadSourceData ? (
              <div className="h-[300px]" role="img" aria-label="Lead sources pie chart: distribution by platform">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={leadSourcePieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      fill="#8884d8"
                      paddingAngle={2}
                      dataKey="value"
                      label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                      labelLine={false}
                    >
                      {leadSourcePieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        color: 'hsl(var(--foreground))'
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <Target className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No lead source data yet.</p>
                  <p className="text-xs mt-1">Generate leads to see distribution.</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Channel Comparison Bar Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Channel Performance Comparison
          </CardTitle>
          <CardDescription>Recorded sent receipts and replies; channel-specific opens, deliveries, and acceptances are shown separately</CardDescription>
        </CardHeader>
        <CardContent>
          {hasChannelData ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={channelComparisonData} barGap={8}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="channel" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                      color: 'hsl(var(--foreground))'
                    }}
                  />
                  <Legend />
                  <Bar dataKey="sent" fill={CHART_COLORS.primary} name="Sent" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="replied" fill={CHART_COLORS.success} name="Replied" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No channel performance data yet.</p>
                <p className="text-xs mt-1">Send outreach messages to see channel comparison.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Campaign Performance Bar Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Campaign Performance
          </CardTitle>
          <CardDescription>Top 10 outreach campaigns by recorded outbound receipts; opens depend on channel tracking</CardDescription>
        </CardHeader>
        <CardContent>
          {hasCampaignData ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={campaignPerformanceData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                      color: 'hsl(var(--foreground))'
                    }}
                  />
                  <Legend />
                  <Bar
                    dataKey="sent"
                    fill={CHART_COLORS.primary}
                    name="Sent"
                  />
                  <Bar
                    dataKey="opened"
                    fill={CHART_COLORS.info}
                    name="Opened"
                  />
                  <Bar
                    dataKey="replied"
                    fill={CHART_COLORS.success}
                    name="Replied"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No campaign data yet.</p>
                <p className="text-xs mt-1">Create and run campaigns to see performance.</p>
              </div>
            </div>
          )}
          {hasCampaignData && <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium">View campaign performance values</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs" aria-label="Campaign performance values">
                <thead><tr><th scope="col">Campaign</th><th scope="col">Sent</th><th scope="col">Opened</th><th scope="col">Replied</th></tr></thead>
                <tbody>{campaignPerformanceData.map(campaign => <tr key={campaign.id}><th scope="row" className="py-2 font-normal">{campaign.name}</th><td>{campaign.sent}</td><td>{campaign.opened}</td><td>{campaign.replied}</td></tr>)}</tbody>
              </table>
            </div>
          </details>}
        </CardContent>
      </Card>

      {/* Channel Performance Analytics */}
      <p className="text-sm text-muted-foreground">Channel rates use recorded sent receipts as their denominator. Opens, SMS deliveries, and LinkedIn acceptances are different events. Missing tracking does not prove no engagement; a dash means no rate denominator is available.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        {/* Email Performance */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Email Performance</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Sent</span>
              <span className="font-medium">{stats?.channelPerformance?.email?.sent || 0}</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Open Rate</span>
                <span className="font-medium">
                  {stats?.channelPerformance?.email?.sent ? `${Math.round(100 * stats.channelPerformance.email.opened / stats.channelPerformance.email.sent)}%` : "—"}
                </span>
              </div>
              <Progress
                value={stats?.channelPerformance?.email?.sent
                  ? (stats.channelPerformance.email.opened / stats.channelPerformance.email.sent) * 100
                  : 0}
                className="h-1.5"
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Reply Rate</span>
                <span className="font-medium text-green-600">
                  {stats?.channelPerformance?.email?.sent ? `${Math.round(100 * stats.channelPerformance.email.replied / stats.channelPerformance.email.sent)}%` : "—"}
                </span>
              </div>
              <Progress
                value={stats?.channelPerformance?.email?.sent
                  ? (stats.channelPerformance.email.replied / stats.channelPerformance.email.sent) * 100
                  : 0}
                className="h-1.5 [&>div]:bg-green-500"
              />
            </div>
            <p className="text-xs text-muted-foreground">{stats?.channelPerformance?.email?.opened ?? '—'} opened / {stats?.channelPerformance?.email?.sent ?? '—'} sent receipts</p>
          </CardContent>
        </Card>

        {/* SMS Performance */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">SMS Performance</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Sent</span>
              <span className="font-medium">{stats?.channelPerformance?.sms?.sent || 0}</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Delivery Rate</span>
                <span className="font-medium">
                  {stats?.channelPerformance?.sms?.sent ? `${Math.round(100 * stats.channelPerformance.sms.delivered / stats.channelPerformance.sms.sent)}%` : "—"}
                </span>
              </div>
              <Progress
                value={stats?.channelPerformance?.sms?.sent
                  ? (stats.channelPerformance.sms.delivered / stats.channelPerformance.sms.sent) * 100
                  : 0}
                className="h-1.5"
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Reply Rate</span>
                <span className="font-medium text-green-600">
                  {stats?.channelPerformance?.sms?.sent ? `${Math.round(100 * stats.channelPerformance.sms.replied / stats.channelPerformance.sms.sent)}%` : "—"}
                </span>
              </div>
              <Progress
                value={stats?.channelPerformance?.sms?.sent
                  ? (stats.channelPerformance.sms.replied / stats.channelPerformance.sms.sent) * 100
                  : 0}
                className="h-1.5 [&>div]:bg-green-500"
              />
            </div>
            <p className="text-xs text-muted-foreground">{stats?.channelPerformance?.sms?.delivered ?? '—'} delivered / {stats?.channelPerformance?.sms?.sent ?? '—'} sent receipts</p>
          </CardContent>
        </Card>

        {/* LinkedIn Performance */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">LinkedIn Performance</CardTitle>
            <Linkedin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Sent</span>
              <span className="font-medium">{stats?.channelPerformance?.linkedin?.sent || 0}</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Accept Rate</span>
                <span className="font-medium">
                  {stats?.channelPerformance?.linkedin?.sent ? `${Math.round(100 * stats.channelPerformance.linkedin.accepted / stats.channelPerformance.linkedin.sent)}%` : "—"}
                </span>
              </div>
              <Progress
                value={stats?.channelPerformance?.linkedin?.sent
                  ? (stats.channelPerformance.linkedin.accepted / stats.channelPerformance.linkedin.sent) * 100
                  : 0}
                className="h-1.5"
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Reply Rate</span>
                <span className="font-medium text-green-600">
                  {stats?.channelPerformance?.linkedin?.sent ? `${Math.round(100 * stats.channelPerformance.linkedin.replied / stats.channelPerformance.linkedin.sent)}%` : "—"}
                </span>
              </div>
              <Progress
                value={stats?.channelPerformance?.linkedin?.sent
                  ? (stats.channelPerformance.linkedin.replied / stats.channelPerformance.linkedin.sent) * 100
                  : 0}
                className="h-1.5 [&>div]:bg-green-500"
              />
            </div>
            <p className="text-xs text-muted-foreground">{stats?.channelPerformance?.linkedin?.accepted ?? '—'} accepted / {stats?.channelPerformance?.linkedin?.sent ?? '—'} sent receipts</p>
          </CardContent>
        </Card>
      </div>

      {/* Lead Sources & Weekly Trends */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Lead Sources Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Lead Sources
            </CardTitle>
            <CardDescription>Distribution of leads by platform</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3.5 w-32 rounded" />
                    <Skeleton className="h-2 w-full rounded" />
                  </div>
                ))}
              </div>
            ) : (stats?.leadSources && stats.leadSources.length > 0) ? (
              stats.leadSources.map((item, index) => (
                <div key={index} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                      {item.source}
                    </span>
                    <span className="font-medium">{item.count} <span className="text-muted-foreground font-normal">({item.percentage}%)</span></span>
                  </div>
                  <Progress value={item.percentage} className="h-2" />
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">No lead data available yet. Start generating leads to see source distribution.</p>
            )}
          </CardContent>
        </Card>

        {/* Weekly Trends */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Weekly Trends
            </CardTitle>
            <CardDescription>UTC weeks start Sunday; current week compared with the previous full week</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {[
              {
                label: 'New Leads',
                current: stats?.weeklyTrends?.leadsThisWeek ?? 0,
                previous: stats?.weeklyTrends?.leadsLastWeek ?? 0,
                icon: Users
              },
              {
                label: 'Messages Sent',
                current: stats?.weeklyTrends?.messagesThisWeek ?? 0,
                previous: stats?.weeklyTrends?.messagesLastWeek ?? 0,
                icon: Mail
              },
              {
                label: 'Recorded first CRM wins',
                current: stats?.recordedWins?.thisWeek ?? 0,
                previous: stats?.recordedWins?.lastWeek ?? 0,
                icon: TrendingUp
              },
            ].filter(metric => metric.label !== "Recorded first CRM wins" || stats?.recordedWins?.coverage !== "restricted").map((metric, index) => {
              const change = metric.previous > 0
                ? Math.round(((metric.current - metric.previous) / metric.previous) * 100)
                : (metric.current > 0 ? 100 : 0);
              const isPositive = change >= 0;
              return (
                <div key={index} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-muted rounded-lg">
                      <metric.icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{metric.label}</p>
                      <p className="text-xs text-muted-foreground">vs last week</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold">{isLoading ? <Skeleton className="inline-block h-6 w-12" /> : metric.current}</div>
                    <p className={`text-xs flex items-center gap-0.5 ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                      {isPositive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                      {Math.abs(change)}%
                    </p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
        </>
      )}
    </div>
  );
}
