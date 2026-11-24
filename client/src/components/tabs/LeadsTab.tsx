import styles from "./campaign-results.module.css";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from 'next/navigation';
import { cn } from "@/lib/utils";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import { InstagramDMModal, SendEmailModal } from "@/components/modals";
import { LeadDetailSheet } from "@/components/LeadDetailSheet";
import { type ActivityLogEntry } from "@/components/WorkflowActivityLog";
import { type Lead } from "@/models/lead";
import { isLeadOutreachLocked } from "@/lib/leadReviewGate";
import { leadEmptyState, normalizeLeadExecutionSummary } from '@/lib/lead-execution-summary';
import { filterLeadsByPlatform, leadPlatformLabel, matchesLeadPlatform as matchPlatform } from '@/lib/lead-platform';
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
 Dialog,
 DialogContent,
 DialogHeader,
 DialogTitle,
} from "@/components/ui/dialog";
import {
 Table,
 TableBody,
 TableCell,
 TableHead,
 TableHeader,
 TableRow,
} from "@/components/ui/table";
import { 
 AlertCircle, 
 CheckCircle, 
 Download, 
 RotateCcw, 
 Mail,
 Linkedin,
 Globe,
 MapPin,
 MoreVertical,
 ChevronRight,
 UserPlus,
 Instagram,
 Save,
 X,
 FileSpreadsheet,
 Upload,
 AlertTriangle,
 ChevronLeft,
 Activity,
 Sparkles,
 Zap,
 Bot,
 Search,
 FileUp,
 FileText,
 Heart,
 MessageSquare,
 Share2,
 Eye as EyeIcon,
 ExternalLink,
 Building2,
} from "lucide-react";



interface LeadsTabProps {
 threadId?: number;
 executionId?: string;
 onSendMessage?: (message: string) => void;
}

interface PlatformProgress {
 platform: string;
 status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
 leadsCount: number;
 maxResults: number;
 leads: Lead[];
 error?: string;
 executionId?: string;
}

interface WorkflowProgress {
 executionId: string;
 status: 'running' | 'completed' | 'error' | 'stopped' | 'cancelled';
 totalLeads: number;
 platforms: PlatformProgress[];
}

// Platform icon component
const PlatformIcon = ({ platform, className = "w-5 h-5" }: { platform: string; className?: string }) => {
 const p = platform?.toLowerCase();
 if (p?.includes('linkedin')) return <Linkedin className={className} />;
 if (p?.includes('twitter') || p?.includes('x.com')) return (
 <svg className={className} fill="currentColor" viewBox="0 0 24 24">
 <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
 </svg>
 );
 if (p?.includes('facebook')) return (
 <svg className={className} fill="currentColor" viewBox="0 0 24 24">
 <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
 </svg>
 );
 if (p?.includes('instagram')) return <Instagram className={className} />;
 if (p?.includes('google') || p?.includes('maps')) return (
 <svg className={className} viewBox="0 0 24 24" aria-label="Google">
 <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.25-.2-1.82H12v3.44h5.52c-.11.86-.7 2.17-2.01 3.04l-.02.11 2.85 2.21.2.02c1.85-1.71 2.92-4.22 2.92-7z" />
 <path fill="#34A853" d="M12 22c2.7 0 4.97-.89 6.63-2.42l-3.16-2.45c-.85.59-1.98 1-3.47 1-2.64 0-4.88-1.74-5.68-4.15l-.1.01-2.96 2.3-.04.09C4.87 19.7 8.18 22 12 22z" />
 <path fill="#FBBC05" d="M6.32 13.98A5.96 5.96 0 016 12c0-.69.12-1.35.32-1.98l-.01-.13-2.99-2.34-.1.05A10.01 10.01 0 002 12c0 1.61.39 3.13 1.08 4.4l3.24-2.42z" />
 <path fill="#EA4335" d="M12 5.87c1.89 0 3.16.81 3.88 1.49l2.83-2.76C16.96 2.98 14.7 2 12 2 8.18 2 4.87 4.3 3.22 7.6l3.1 2.42C7.12 7.61 9.36 5.87 12 5.87z" />
 </svg>
 );
 if (p?.includes('justdial')) return <MapPin className={className} />;
 return <Globe className={className} />;
};

// Platform color mapping
const getPlatformColor = (platform: string) => {
 const p = platform?.toLowerCase();
 if (p?.includes('linkedin')) return { bg: 'bg-blue-500', text: 'text-blue-500', light: 'bg-blue-50 dark:bg-blue-950' };
 if (p?.includes('twitter') || p?.includes('x.com')) return { bg: 'bg-black', text: 'text-black dark:text-white', light: 'bg-secondary' };
 if (p?.includes('facebook')) return { bg: 'bg-blue-600', text: 'text-blue-600', light: 'bg-blue-50 dark:bg-blue-950' };
 if (p?.includes('instagram')) return { bg: 'bg-pink-500', text: 'text-pink-500', light: 'bg-pink-50 dark:bg-pink-950' };
 if (p?.includes('google') || p?.includes('maps')) return { bg: 'bg-white border border-slate-200 dark:border-slate-700', text: 'text-slate-700 dark:text-slate-200', light: 'bg-slate-50 dark:bg-slate-900/40' };
 if (p?.includes('justdial')) return { bg: 'bg-yellow-500', text: 'text-yellow-600', light: 'bg-yellow-50 dark:bg-yellow-950' };
 return { bg: 'bg-gray-500', text: 'text-muted-foreground', light: 'bg-secondary' };
};

const normalizeProviderStatus = (status: string): PlatformProgress['status'] => {
  if (status === 'running' || status === 'syncing') return 'running';
  if (status === 'pending') return 'pending';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'stopped') return 'error';
  return 'completed';
};

// Helper function to format location object to string
const formatLocation = (location: unknown): string => {
 if (!location) return '';
 if (typeof location === 'string') return location;
 if (typeof location === 'object') {
 const loc = location as { city?: string; address?: string; country?: string; state?: string };
 const parts: string[] = [];
 if (loc.city) parts.push(loc.city);
 if (loc.state) parts.push(loc.state);
 if (loc.country) parts.push(loc.country);
 if (parts.length === 0 && loc.address) return loc.address;
 return parts.join(', ');
 }
 return '';
};

// Lead card component for preview with more details
const LeadPreviewCard = ({ lead, onClick, _onEnrich, isEnriching }: { lead: Lead; onClick: () => void; _onEnrich?: (leadId: number) => void; isEnriching?: boolean }) => {
 const locationStr = formatLocation(lead.location || lead.address);
 const imageUrl = lead.profilePicture || lead.imageUrl || lead.photo;
 const isCompany = lead.leadType === 'company';
 const isPlace = lead.leadType === 'place' || lead.leadType === 'local_business';
 
 return (
  <button
  type="button"
  onClick={onClick}
  className="group relative w-full min-w-0 cursor-pointer overflow-hidden rounded-xl border border-border/60 bg-card p-3.5 text-left shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:border-primary/40 hover:shadow-md active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  >
  
  {/* Enrichment loading overlay */}
  {isEnriching && (
  <div className="absolute inset-0 z-20 bg-background/60 rounded-xl flex items-center justify-center">
  <div className="flex flex-col items-center gap-1.5">
  <Spinner size="md" label={null} className="text-primary" />
  <span className="text-[10px] font-semibold text-primary uppercase">Enriching Profile</span>
  </div>
  </div>
  )}
  
  <div className="flex items-start gap-3.5 relative z-10">
  <div className="relative shrink-0">
  <div className={cn(
    "relative h-10 w-10 overflow-hidden border border-border/60 bg-background shadow-sm transition-transform duration-200",
    isCompany || isPlace ? "rounded-lg" : "rounded-full",
  )}>
  {imageUrl ? (
  <img 
  src={imageUrl} 
  alt={lead.name || 'Lead'} 
  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
  onError={(e) => {
  (e.target as HTMLImageElement).style.display = 'none';
  (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
  }}
  />
  ) : null}
  <div className={`w-full h-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-base ${imageUrl ? 'hidden' : ''}`}>
  {isCompany || isPlace ? (
  <Building2 className="w-5 h-5 text-primary" />
  ) : (
  lead.name?.charAt(0).toUpperCase() || '?'
  )}
  </div>
  </div>
  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-card rounded-full flex items-center justify-center shadow border border-border/40">
  <Zap className="w-2.5 h-2.5 text-primary fill-primary/20" />
  </div>
  </div>
  
  <div className="flex-1 min-w-0">
  <div className="flex items-center justify-between gap-2 mb-0.5">
  <p className="font-semibold text-[13px] text-foreground truncate group-hover:text-primary transition-colors">
  {lead.name || (isCompany || isPlace ? 'Unknown Business' : 'Unknown Profile')}
  </p>
  </div>
  <p className="text-[9px] font-semibold text-muted-foreground/40 truncate uppercase mb-1.5">
  {isCompany || isPlace 
  ? `${lead.industry || 'Company'}${lead.companySize ? ` · ${lead.companySize}` : ''}`
  : lead.company || lead.role || 'Priority Lead'}
  </p>
 
 {lead.businessCategoryName && (
 <div className="flex items-center gap-1.5 mb-3">
 <Badge variant="outline" className="text-[10px] font-semibold px-1.5 py-0.5 border-border/40 bg-background/30 text-muted-foreground/60 uppercase rounded-lg">
 {lead.businessCategoryName}{lead.businessSubcategoryName ? ` · ${lead.businessSubcategoryName}` : ''}
 </Badge>
 </div>
 )}

 <div className="grid grid-cols-1 gap-1 pt-2 border-t border-border/40">
 {!!locationStr && (
 <div className="flex items-center gap-2 text-[9px] font-semibold text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors uppercase">
 <MapPin className="w-2.5 h-2.5 text-primary/30" />
 <span className="truncate">{String(locationStr)}</span>
 </div>
 )}
 {(lead.email || lead.phone) && (
 <div className="flex items-center gap-2 text-[9px] font-semibold text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors uppercase">
 <Mail className="w-2.5 h-2.5 text-primary/30" />
 <span className="truncate">{String(lead.email || lead.phone)}</span>
 </div>
 )}
 </div>
 </div>
 </div>
 </button>
 );
};

export default function LeadsTab({ threadId, executionId, onSendMessage }: LeadsTabProps) {
 const router = useRouter();
 const [leads, setLeads] = useState<Lead[]>([]);
 const [loading, setLoading] = useState(true);
 const [leadLoadError, setLeadLoadError] = useState<string | null>(null);
 const leadRequestVersion = useRef(0);
 const leadsInFlight = useRef(0);
 useEffect(() => {
   setLoading(true);
   setLeads([]);
   setLeadLoadError(null);
   return () => { leadRequestVersion.current += 1; };
 }, [threadId, executionId]);
 const [workflowProgress, setWorkflowProgress] = useState<WorkflowProgress | null>(null);
 const [retrying, setRetrying] = useState(false);
 const [leadReviewState, setLeadReviewState] = useState({
 workflowExecuted: false,
 approved: false,
 loading: true,
 error: false,
 });
 
 // Activity log state
 const [_, setActivityLogs] = useState<ActivityLogEntry[]>([]);
  // Phase 9.15: prefer `string | null` over `string | undefined` for an
  // initial-empty value. The `|| 'multiple sources'` fallthrough at the
  // call site handles both null and undefined the same way, but `null`
  // is the idiomatic empty-value marker in React state.
  const [currentPlatform, setCurrentPlatform] = useState<string | null>(null);
 
 // View More dialog state
 const [viewMoreDialog, setViewMoreDialog] = useState<{
 open: boolean;
 platform: string;
 leadType: string;
 leads: Lead[];
 }>({ open: false, platform: '', leadType: 'all', leads: [] });
 
 // Lead detail sheet state
 const [leadDetailOpen, setLeadDetailOpen] = useState(false);
 const [selectedLeadForDetail, setSelectedLeadForDetail] = useState<Lead | null>(null);
 
 // Modal states
 const [instagramDMModalOpen, setInstagramDMModalOpen] = useState(false);
 const [sendEmailModalOpen, setSendEmailModalOpen] = useState(false);
 const [selectedLeadsForModal, setSelectedLeadsForModal] = useState<Lead[]>([]);
 
 // Enrichment state
 const [enrichingLeadIds, setEnrichingLeadIds] = useState<Set<number>>(new Set());
 const [enrichingAll, setEnrichingAll] = useState(false);
 const [platformFilters, setPlatformFilters] = useState<Record<string, string>>({});

 // Add Lead dialog state
 const [addLeadDialogOpen, setAddLeadDialogOpen] = useState(false);
 const [addLeadForm, setAddLeadForm] = useState({
 firstName: '',
 lastName: '',
 email: '',
 phone: '',
 company: '',
 role: '',
 location: '',
 website: '',
 linkedin: '',
 notes: '',
 });
 const [addLeadSaving, setAddLeadSaving] = useState(false);

 // Import leads dialog state
 type ImportLead = Record<string, unknown>;
 const [importDialogOpen, setImportDialogOpen] = useState(false);
 const [importStep, setImportStep] = useState<'upload' | 'preview'>('upload');
 const [importFile, setImportFile] = useState<File | null>(null);
 const importRequestId = useRef<string | null>(null);
 const [importDragging, setImportDragging] = useState(false);
 const [importParsing, setImportParsing] = useState(false);
 const [importLeads, setImportLeads] = useState<ImportLead[]>([]);
 const [importSaving, setImportSaving] = useState(false);
 const [importError, setImportError] = useState<string | null>(null);

  // View toggle: leads or posts
  const [activeView, _setActiveView] = useState<'leads' | 'posts'>('leads');

 // Posts state
 interface ScrapedPost {
 id: number;
 platform: string;
 source: string;
 postId: string;
 postUrl?: string | null;
 authorName?: string | null;
 authorUsername?: string | null;
 authorProfileUrl?: string | null;
 text?: string | null;
 caption?: string | null;
 postType?: string | null;
 likesCount?: number | null;
 commentsCount?: number | null;
 sharesCount?: number | null;
 retweetCount?: number | null;
 viewCount?: number | null;
 searchQuery?: string | null;
 searchHashtag?: string | null;
 mediaUrls?: string | null;
 createdAt?: string | null;
 createdAtDb?: string | null;
 }
 const [posts, setPosts] = useState<ScrapedPost[]>([]);
 const [postsLoading, setPostsLoading] = useState(false);

 const loadPosts = useCallback(async () => {
 setPostsLoading(true);
 try {
 let url = '/api/posts';
 if (threadId) url = `/api/posts/thread/${threadId}`;
 const response = await api.get<ScrapedPost[]>(url);
 setPosts(Array.isArray(response) ? response : []);
 } catch {
 // silently ignore
 } finally {
 setPostsLoading(false);
 }
 }, [threadId]);
 
 const { subscribe: wsSubscribe } = useWebSocket();
 const { toast } = useToast();

  const [cancelling, setCancelling] = useState(false);

  const handleCancelPlatform = async () => {
    // Find the currently active platform's executionId
    const activePlatform = workflowProgress?.platforms.find(p => p.status === 'running');
    const execId = activePlatform?.executionId || workflowProgress?.executionId;
    if (!execId) {
      toast({ title: 'Error', description: 'No active execution ID found to cancel', variant: 'destructive' });
      return;
    }
    
    setCancelling(true);
    try {
      await api.post('/api/workflow/cancel', { executionId: execId });
      toast({ title: 'Success', description: `Skipping search for ${activePlatform?.platform || 'current platform'}. Moving to next platform...` });
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to skip current search', variant: 'destructive' });
    } finally {
      setCancelling(false);
    }
  };

  const handleStopAllWorkflows = async () => {
    setCancelling(true);
    try {
      // 1. Tell the backend to stop the entire loop for this thread
      await api.post(`/api/workflow/stop-thread`, { threadId });
      
      // 2. Cancel the currently running platform execution to abort it immediately
      const activePlatform = workflowProgress?.platforms.find(p => p.status === 'running');
      const execId = activePlatform?.executionId || workflowProgress?.executionId;
      if (execId) {
        await api.post('/api/workflow/cancel', { executionId: execId });
      }
      
      toast({ title: 'Success', description: 'Lead generation stopped entirely.' });
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to stop lead generation', variant: 'destructive' });
    } finally {
      setCancelling(false);
    }
  };

 // Helper function to add activity log
 const addActivityLog = useCallback((entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => {
 const newEntry: ActivityLogEntry = {
 ...entry,
 id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
 timestamp: new Date(),
 };
 setActivityLogs(prev => [...prev, newEntry]);
 }, []);

 // Load activity logs from database
 const loadActivityLogs = useCallback(async () => {
 if (!executionId && !threadId) return;
 
 try {
 const url = executionId 
 ? `/api/workflow/logs/${executionId}` 
 : `/api/workflow/logs/thread/${threadId}`;
 
 const response = await api.get<Array<{
 id: number;
 logType: string;
 status: string;
 platform: string | null;
 actorId: string | null;
 message: string;
 details: Record<string, unknown> | null;
 leadsCount: number | null;
 errorMessage: string | null;
 createdAt: string;
 }>>(url);
 
 if (Array.isArray(response)) {
 // Convert database logs to ActivityLogEntry format
 const dbLogs: ActivityLogEntry[] = response.map((log) => ({
 id: `db-${log.id}`,
 type: log.logType as ActivityLogEntry['type'],
 timestamp: new Date(log.createdAt),
 platform: log.platform || undefined,
 actorId: log.actorId || undefined,
 message: log.message,
 status: log.status as ActivityLogEntry['status'],
 leadsCount: log.leadsCount || undefined,
 details: log.details || undefined,
 }));
 
 // Replace logs with database logs (real-time logs will be added via WebSocket)
 setActivityLogs(dbLogs);
 }
 } catch (error) {
 console.error('[LeadsTab] Error loading activity logs:', error);
 }
 }, [executionId, threadId]);

 // Load leads from API
 const loadLeads = useCallback(async () => {
 const requestVersion = ++leadRequestVersion.current;
 leadsInFlight.current = requestVersion;
 try {
 let url = '/api/leads';
 if (threadId) {
 url = `/api/leads/thread/${threadId}`;
 } else if (executionId) {
 url = `/api/leads/execution/${executionId}`;
 }
 
 const response = await api.get<Lead[]>(url);
 if (requestVersion !== leadRequestVersion.current) return;
 if (!Array.isArray(response)) throw new Error('The server returned an invalid lead list. Please refresh the results.');
 setLeads(response);
 setLeadLoadError(null);
 } catch (error: unknown) {
 if (requestVersion !== leadRequestVersion.current) return;
 console.error('[LeadsTab] Error loading leads:', error);
 setLeadLoadError(error instanceof Error ? error.message : 'The saved leads could not be loaded.');
 } finally {
 if (requestVersion === leadRequestVersion.current) setLoading(false);
 if (leadsInFlight.current === requestVersion) leadsInFlight.current = 0;
 }
 }, [threadId, executionId]);

 // Load scraping details from database
 const loadScrapingDetails = useCallback(async () => {
 if (!threadId) return;
 
 try {
 const response = await api.get<{ executionId: string; platform: string; status: string; totalLeadsFound: number; estimatedLeads?: number; totalLeadsNeeded?: number }[]>(`/api/chat/threads/${threadId}/scraping-details/latest`);
 
 if (response && response.length > 0) {
 const totalLeadsFound = response.reduce((sum, r) => sum + (r.totalLeadsFound || 0), 0);
 const hasRunning = response.some(r => r.status === 'running' || r.status === 'syncing' || r.status === 'pending');
 const hasError = response.some(r => r.status === 'error' || r.status === 'failed');
 const hasCancelled = response.some(r => r.status === 'cancelled' || r.status === 'stopped');
 
 // Determine overall status
 let overallStatus: WorkflowProgress['status'] = 'completed';
 if (hasRunning) overallStatus = 'running';
 else if (hasError) overallStatus = 'error';
 else if (hasCancelled) overallStatus = 'cancelled';
 
 setWorkflowProgress(() => {
 return {
 executionId: response[0].executionId,
 status: overallStatus,
 totalLeads: totalLeadsFound,
 platforms: response.map(r => {
 const matchedLeads = leads.filter(lead => matchPlatform(lead.platformType || lead.source || '', r.platform));
 return {
 platform: r.platform,
 status: normalizeProviderStatus(r.status),
 leadsCount: r.totalLeadsFound || 0,
 maxResults: r.estimatedLeads || r.totalLeadsNeeded || 10,
 leads: matchedLeads,
 error: (r as { error?: string }).error,
 executionId: r.executionId,
 };
 }),
 };
 });
 }
 } catch (error: unknown) {
 console.error('[LeadsTab] Error loading scraping details:', error);
 }
 }, [threadId, leads]);

 const loadLeadReviewState = useCallback(async () => {
 if (!threadId) return;
 try {
 const state = await api.get<{ leadWorkflowExecuted?: boolean; leadReviewApproved?: boolean }>(`/api/chat/langgraph/state/${threadId}`);
 setLeadReviewState({
 workflowExecuted: state.leadWorkflowExecuted === true,
 approved: state.leadReviewApproved === true,
 loading: false,
 error: false,
 });
 } catch (error) {
 console.error('[LeadsTab] Error loading lead review state:', error);
 setLeadReviewState((previous) => ({ ...previous, loading: false, error: true }));
 }
 }, [threadId]);

 // Check for running workflow executions (for when tab opens after workflow started)
  const checkRunningWorkflows = useCallback(async () => {
    if (!threadId) return;
    
    try {
      // Try to load activity logs which will indicate a running workflow
      const response = await api.get<{ logType: string; status: string; platform?: string; executionId: string }[]>(
        `/api/workflow/logs/thread/${threadId}?limit=10`
      );
      
      const logsResponse = response || [];
      
      if (logsResponse && logsResponse.length > 0) {
        // Find the latest lifecycle log
        const lifeCycleLog = logsResponse.find(log => 
          log.logType === 'workflow_start' || 
          log.logType === 'workflow_complete' || 
          log.logType === 'workflow_error' ||
          log.status === 'cancelled'
        );
        
        const isRunning = lifeCycleLog ? (lifeCycleLog.logType === 'workflow_start' && lifeCycleLog.status !== 'cancelled') : false;
        
        if (isRunning) {
          const platforms = [...new Set(logsResponse.filter(log => log.platform).map(log => log.platform as string))];
          const executionId = lifeCycleLog?.executionId || logsResponse[0].executionId;
          
          // Set workflow progress to show the UI (functional update avoids workflowProgress dependency)
          setWorkflowProgress(prev => {
            if (prev) return prev;
            return {
              executionId,
              status: 'running',
              totalLeads: 0,
              platforms: platforms.map(p => ({
                platform: p,
                status: 'running',
                leadsCount: 0,
                maxResults: 10,
                leads: [],
                executionId,
              })),
            };
          });
        } else {
          // Not running, clear active status if any (functional update avoids workflowProgress dependency)
          setWorkflowProgress(prev => prev && prev.status === 'running' ? null : prev);
        }
      }
    } catch (_error) {
      // Silently ignore - API might not be available yet
    }
  }, [threadId]);

 // Subscribe to workflow progress
 useEffect(() => {
 loadLeads();
 loadActivityLogs();
 checkRunningWorkflows(); // Check for running workflows on mount
 loadLeadReviewState();
 loadPosts(); // Also load posts on mount
 }, [loadLeads, loadActivityLogs, checkRunningWorkflows, loadLeadReviewState, loadPosts]);

 // Always restore persisted provider state, including empty/failed runs. While a
 // workflow is active this also drives restart recovery through the API lease.
 useEffect(() => {
 loadScrapingDetails();
 }, [loadScrapingDetails]);

 useEffect(() => {
 if (workflowProgress?.status !== 'running') return;
 const interval = window.setInterval(() => {
 // A hidden tab skips polls; the next tick after it is shown catches up.
 if (document.visibilityState === 'hidden') return;
 void loadScrapingDetails();
 // Never supersede a lead read that is still running: when the API is
 // slower than this interval the list would never load.
 if (!leadsInFlight.current) void loadLeads();
 }, 3000);
 return () => window.clearInterval(interval);
 }, [workflowProgress?.status, loadScrapingDetails, loadLeads]);

 useEffect(() => {
 if (!threadId || leadReviewState.approved) return;
 const interval = window.setInterval(() => {
 if (document.visibilityState !== 'hidden') void loadLeadReviewState();
 }, 3000);
 return () => window.clearInterval(interval);
 }, [threadId, leadReviewState.workflowExecuted, leadReviewState.approved, loadLeadReviewState]);

 // WebSocket subscriptions
 useEffect(() => {
 const unsubWorkflowStarted = wsSubscribe('workflow_started', (data: Record<string, unknown>) => {
 // Handle both old format (executionId, platforms array) and new format (execution_id, platform string)
 const executionId = (data.executionId || data.execution_id) as string;
 const platformsArray = data.platforms as string[] || (data.platform ? [data.platform as string] : []);
 const maxResults = data.maxResults as Record<string, number> | undefined;
 
 setWorkflowProgress({
 executionId: executionId || '',
 status: 'running',
 totalLeads: 0,
 platforms: platformsArray.map((p: string) => ({
 platform: p,
 status: 'pending',
 leadsCount: 0,
 maxResults: maxResults?.[p] || 10,
 leads: [],
 executionId: executionId || '',
 })),
 });
 
 // Add activity log for workflow start
 addActivityLog({
 type: 'workflow_start',
 message: `Workflow started with ${platformsArray.length || 0} platform(s)`,
 details: { platforms: platformsArray, executionId },
 });
 
 // Clear previous logs for new workflow
 setActivityLogs([]);
 });

 const unsubWorkflowStep = wsSubscribe('workflow_step', (data: Record<string, unknown>) => {
 const event = data as { 
 platform: string; 
 step: string;
 message: string;
 leadsCount?: number; 
 totalLeads?: number;
 metadata?: Record<string, unknown>;
 execution_id?: string;
 };
 
 setCurrentPlatform(event.platform);
 
 setWorkflowProgress(prev => {
 if (!prev) return prev;
 return {
 ...prev,
 platforms: prev.platforms.map(p => 
 p.platform === event.platform 
 ? { ...p, status: 'running', leadsCount: event.leadsCount || p.leadsCount, executionId: event.execution_id || (event.metadata?.executionId as string) || p.executionId }
 : p
 ),
 totalLeads: event.totalLeads || prev.totalLeads,
 };
 });
 
 // Add activity log for workflow step
 addActivityLog({
 type: 'step',
 platform: event.platform,
 message: event.message || `Processing step: ${event.step}`,
 status: 'running',
 details: event.metadata,
 });
 });

 const unsubWorkflowCompleted = wsSubscribe('workflow_completed', (data: Record<string, unknown>) => {
 const event = data as { platform: string; leadsCount: number };
 setWorkflowProgress(prev => {
 if (!prev) return prev;
 const updated = {
 ...prev,
 platforms: prev.platforms.map(p =>
 p.platform === event.platform
 ? { ...p, status: 'completed' as const, leadsCount: event.leadsCount }
 : p
 ),
 };
 // If all platforms are done (completed or errored), set overall status to completed
 const allDone = updated.platforms.every(p => p.status === 'completed' || p.status === 'error');
 if (allDone) {
 return { ...updated, status: 'completed' };
 }
 return updated;
 });
 
 // Add activity log for platform completion
 addActivityLog({
 type: 'actor_complete',
 status: 'completed',
 message: `Completed ${event.platform} lead generation`,
 leadsCount: event.leadsCount,
 });
 
 setCurrentPlatform(null);
 loadLeads();
 });

 const unsubWorkflowError = wsSubscribe('workflow_error', (data: Record<string, unknown>) => {
 const event = data as { executionId: string; error: string; platform?: string };
 setWorkflowProgress(prev => {
 if (!prev) return prev;
 const updated = {
 ...prev,
 platforms: prev.platforms.map(p =>
 p.platform === event.platform
 ? { ...p, status: 'error' as const, error: event.error }
 : p
 ),
 };
 // If all platforms are done (completed or errored), set overall status to error
 const allDone = updated.platforms.every(p => p.status === 'completed' || p.status === 'error');
 if (allDone) {
 return { ...updated, status: 'error' };
 }
 return updated;
 });
 
 // Add activity log for error
 addActivityLog({
 type: 'error',
 platform: event.platform,
 message: event.error || 'Workflow error occurred',
 details: { executionId: event.executionId },
 });
 });

 const unsubLeadSaved = wsSubscribe('lead_saved', (event: Record<string, unknown>) => {
 const newLead = (event.lead as Lead | undefined) || undefined;
 const platform = (event.platform as string | undefined) || 'unknown';
 const count = typeof event.count === 'number' ? event.count : 1;

 if (newLead) {
 setLeads(prev => [...prev, newLead]);
 }

 setWorkflowProgress(prev => {
 if (!prev) return prev;
 const newTotalLeads = prev.totalLeads + count;

 // Add activity log for lead saved (only every 10 leads to avoid spam)
 if (newTotalLeads % 10 === 0 || newTotalLeads === 1) {
 addActivityLog({
 type: 'lead_saved',
 platform,
 message: `Saved ${newTotalLeads} lead(s) so far`,
 leadsCount: newTotalLeads,
 details: newTotalLeads === 1 && newLead ? { 
 firstLead: { 
 name: newLead.name, 
 company: newLead.company, 
 email: newLead.email 
 } 
 } : undefined,
 });
 }

 return {
 ...prev,
 totalLeads: newTotalLeads,
 platforms: prev.platforms.map(p =>
 p.platform === platform
 ? {
 ...p,
 leadsCount: p.leadsCount + count,
 leads: newLead ? [...p.leads, newLead] : p.leads,
 }
 : p
 ),
 };
 });
 });

 // Handle batch lead saves (server sends all leads in a single WS message)
 const unsubLeadsBatchSaved = wsSubscribe('leads_batch_saved', (event: Record<string, unknown>) => {
 const newLeads = (event.leads as Lead[] | undefined) || [];
 const platform = (event.platform as string | undefined) || 'unknown';
 const count = typeof event.count === 'number' ? event.count : newLeads.length;

 if (newLeads.length > 0) {
 setLeads(prev => [...prev, ...newLeads]);
 }

 setWorkflowProgress(prev => {
 if (!prev) return prev;
 const newTotalLeads = prev.totalLeads + count;

 addActivityLog({
 type: 'lead_saved',
 platform,
 message: `Saved ${count} lead(s) (${newTotalLeads} total)`,
 leadsCount: newTotalLeads,
 });

 return {
 ...prev,
 totalLeads: newTotalLeads,
 platforms: prev.platforms.map(p =>
 p.platform === platform
 ? {
 ...p,
 leadsCount: p.leadsCount + count,
 leads: [...p.leads, ...newLeads],
 }
 : p
 ),
 };
 });
 });

 const unsubExecutionSummary = wsSubscribe('execution_summary', (data: Record<string, unknown>) => {
 const metadata = normalizeLeadExecutionSummary(data);
 if (metadata.status === 'unknown') {
   void loadScrapingDetails();
   void loadLeads();
   return;
 }
 
 setWorkflowProgress(prev => {
 if (!prev) return prev;
 const terminalStatus: WorkflowProgress['status'] = metadata.status === 'failed'
   ? 'error'
   : metadata.status === 'cancelled'
     ? 'cancelled'
     : 'completed';
 return { 
 ...prev, 
 status: terminalStatus,
 totalLeads: metadata.totalLeads ?? prev.totalLeads,
 platforms: prev.platforms.map(p => {
   const result = metadata.results?.find(item => matchPlatform(item.platform, p.platform));
   return { ...p, status: result?.success === false ? 'error' as const : result?.success === true ? 'completed' as const : p.status, leadsCount: result?.leads_count ?? p.leadsCount, error: result?.error ?? p.error };
 }),
 };
 });
 
 // Add activity log for workflow completion
 const totalLeads = metadata.totalLeads ?? 0;
 const successCount = metadata.successCount;
 addActivityLog({
 type: 'completed',
 message: `Workflow ${metadata.status || 'completed'}: ${totalLeads} persisted leads from ${successCount} platform(s)`,
 totalLeads,
 details: { results: metadata.results },
 });
 
 setCurrentPlatform(null);
 loadLeads();
 });

 // Listen for enrichment completion to refresh lead data
 const unsubEnrichCompleted = wsSubscribe('completed', (data: Record<string, unknown>) => {
 const toolName = data.toolName as string | undefined;
 const execId = data.executionId as string | undefined;
 if (toolName !== 'deep_enrichment' || !execId) return;
 // executionId format: 'enrich-{leadId}'
 const match = execId.match(/^enrich-(\d+)$/);
 if (!match) return;
 const leadId = parseInt(match[1], 10);
 // Remove from enriching set
 setEnrichingLeadIds(prev => { const s = new Set(prev); s.delete(leadId); return s; });
 // Refresh that single lead
 (async () => {
 try {
 const updated = await api.get<Lead>(`/api/leads/${leadId}`);
 if (updated) {
 setLeads(prev => prev.map(l => l.id === leadId ? updated : l));
 }
 } catch {
 // Fallback: reload all leads
 loadLeads();
 }
 })();
 });

 return () => {
 unsubWorkflowStarted();
 unsubWorkflowStep();
 unsubWorkflowCompleted();
 unsubWorkflowError();
 unsubLeadSaved();
 unsubLeadsBatchSaved();
 unsubExecutionSummary();
 unsubEnrichCompleted();
 };
 }, [wsSubscribe, loadLeads, addActivityLog]);

 // Retry failed workflow
 const handleRetry = async (workflowId: string) => {
 if (!workflowProgress?.status || !workflowId || !threadId || retrying) return;
 try {
 setRetrying(true);
 const review = await api.get<{ inputs?: Array<{ platform: string; workflowId?: string; requestedLeadTotal?: number }> }>(`/api/workflows/existing-inputs/${threadId}`);
 const reviewedInput = review.inputs?.find((input) => input.workflowId === workflowId || input.platform === workflowId);
 const reviewedTotal = Number(reviewedInput?.requestedLeadTotal);
 if (!Number.isSafeInteger(reviewedTotal) || reviewedTotal <= 0) {
 toast({
 title: 'Retry requires a reviewed cap',
 description: 'Regenerate this provider’s inputs and review an explicit global lead cap before execution.',
 variant: 'destructive',
 });
 return;
 }
 // A failed run is terminal. Bind the selected strategy to the new run before
 // asking for replacement inputs; plain chat regeneration has no selection.
 const response = await api.post<{ error?: string }>('/api/chat/langgraph/action', {
 threadId,
 action: 'LEAD_AGENT_USE_WORKFLOW',
 data: {
 workflowId: reviewedInput?.workflowId || workflowId,
 platform: reviewedInput?.platform || workflowId,
 message: `Regenerate the reviewed lead inputs using only ${workflowId}. Reuse the same ICP, geography, industry, and provider-specific targeting, enforce a global cap of exactly ${reviewedTotal} lead${reviewedTotal === 1 ? '' : 's'}, and show the exact provider parameters for review. Do not execute yet, substitute a broad provider, or create duplicate leads.`,
 },
 });
 if (response.error) throw new Error(response.error);
 } catch (error) {
 toast({ title: 'Could not prepare retry', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
 } finally {
 setRetrying(false);
 }
 };

 // Enrich a single lead
 const handleEnrichLead = async (leadId: number) => {
 setEnrichingLeadIds(prev => new Set(prev).add(leadId));
 try {
 await api.post(`/api/leads/${leadId}/deep-enrich`, { async: true });
 toast({ title: 'Enrichment Started', description: 'Lead enrichment is running. The row will update automatically.' });
 } catch {
 toast({ title: 'Error', description: 'Failed to start enrichment', variant: 'destructive' });
 setEnrichingLeadIds(prev => { const s = new Set(prev); s.delete(leadId); return s; });
 }
 };

 // Enrich all leads
 const handleEnrichAll = async () => {
 if (leads.length === 0) return;
 setEnrichingAll(true);
 const ids = leads.map(l => l.id).filter(Boolean) as number[];
 setEnrichingLeadIds(new Set(ids));
 let started = 0;
 for (const id of ids) {
 try {
 await api.post(`/api/leads/${id}/deep-enrich`, { async: true });
 started++;
 } catch {
 setEnrichingLeadIds(prev => { const s = new Set(prev); s.delete(id); return s; });
 }
 }
 setEnrichingAll(false);
 if (started > 0) {
 toast({ title: 'Enrichment Started', description: `Enriching ${started} lead(s). Rows will update automatically.` });
 }
 };

 // Export leads
 const handleExport = async () => {
 try {
 const response = await api.get<string>(`/api/leads/export?format=csv${threadId ? `&threadId=${threadId}` : ''}`);
 const blob = new Blob([response], { type: 'text/csv' });
 const url = window.URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `leads-${new Date().toISOString().split('T')[0]}.csv`;
 a.click();
 toast({ title: 'Success', description: 'Leads exported successfully' });
 } catch {
 toast({ title: 'Error', description: 'Failed to export leads', variant: 'destructive' });
 }
 };

 // Open Add Lead dialog instead of navigating away
 const handleAddLead = () => {
 setAddLeadForm({ firstName: '', lastName: '', email: '', phone: '', company: '', role: '', location: '', website: '', linkedin: '', notes: '' });
 setAddLeadDialogOpen(true);
 };

 // Submit Add Lead dialog
 const handleAddLeadSubmit = async () => {
 if (!addLeadForm.email.trim()) {
 toast({ title: 'Validation Error', description: 'Email is required', variant: 'destructive' });
 return;
 }
 const fullName = `${addLeadForm.firstName.trim()} ${addLeadForm.lastName.trim()}`.trim() || 'Unknown';
 try {
 setAddLeadSaving(true);
 await api.post('/api/leads', {
 name: fullName,
 firstName: addLeadForm.firstName.trim() || null,
 lastName: addLeadForm.lastName.trim() || null,
 email: addLeadForm.email.trim(),
 phone: addLeadForm.phone.trim() || null,
 company: addLeadForm.company.trim() || null,
 role: addLeadForm.role.trim() || null,
 location: addLeadForm.location.trim() || null,
 website: addLeadForm.website.trim() || null,
 linkedin: addLeadForm.linkedin.trim() || null,
 notes: addLeadForm.notes.trim() || null,
 source: 'manual',
 status: 'new',
 ...(threadId ? { threadId } : {}),
 });
 toast({ title: 'Success', description: 'Lead added successfully' });
 setAddLeadDialogOpen(false);
 loadLeads();
 } catch {
 toast({ title: 'Error', description: 'Failed to add lead', variant: 'destructive' });
 } finally {
 setAddLeadSaving(false);
 }
 };

 // Import dialog helpers
 const isMissingImportant = (lead: Record<string, unknown>) => {
 const hasName = !!(lead.first_name || lead.firstName || lead.last_name || lead.lastName || lead.name);
 const hasCompany = !!(lead.company);
 return !hasName || !hasCompany;
 };

 const handleImportFileSelect = (file: File) => {
 const ext = file.name.toLowerCase().split('.').pop();
 if (!['csv', 'xls', 'xlsx'].includes(ext || '')) {
 setImportError('Please upload a CSV or Excel file (.csv, .xls, .xlsx)');
 return;
 }
 if (file.size > 10 * 1024 * 1024) {
 setImportError('File size must be less than 10MB');
 return;
 }
 setImportFile(file);
 importRequestId.current = crypto.randomUUID();
 setImportError(null);
 };

 const handleImportParse = async () => {
 if (!importFile) return;
 setImportParsing(true);
 setImportError(null);
 try {
 const formData = new FormData();
 formData.append('leads_file', importFile);
 const data = await api.postForm<{ success: boolean; leads: Lead[]; error?: string; message?: string }>('/api/leads/import/csv', formData);
 if (!data.success) throw new Error(data.error || data.message || 'Parse failed');
 setImportLeads(data.leads || []);
 setImportStep('preview');
 } catch (err) {
 setImportError(err instanceof Error ? err.message : 'Failed to parse file');
 } finally {
 setImportParsing(false);
 }
 };

 const handleImportSave = async () => {
 if (!importLeads.length) return;
 setImportSaving(true);
 try {
 const result = await api.post<{ success: boolean; imported: number }>('/api/leads/import/save', {
 leads: importLeads,
 fileName: importFile?.name || 'Lead upload',
 ...(importRequestId.current ? { requestId: importRequestId.current } : {}),
 ...(threadId ? { threadId } : {}),
 });
 toast({ title: 'Import successful', description: `${result.imported} leads imported` });
 setImportDialogOpen(false);
 setImportStep('upload');
 setImportFile(null);
 importRequestId.current = null;
 setImportLeads([]);
 loadLeads();
 } catch {
 toast({ title: 'Import failed', description: 'Could not save leads', variant: 'destructive' });
 } finally {
 setImportSaving(false);
 }
 };

  // Formatting helper for leadType labels
  const formatLeadTypeLabel = (leadType: string, count: number = 2) => {
    const lt = leadType?.toLowerCase() || 'profile';
    if (lt === 'company') return count === 1 ? 'Company' : 'Companies';
    if (lt === 'local_business' || lt === 'place') return count === 1 ? 'Business' : 'Businesses';
    if (lt === 'page') return count === 1 ? 'Page' : 'Pages';
    if (lt === 'author') return count === 1 ? 'Author' : 'Authors';
    if (lt === 'commenter') return count === 1 ? 'Commenter' : 'Commenters';
    if (lt === 'liker') return count === 1 ? 'Liker' : 'Likers';
    if (lt === 'post') return count === 1 ? 'Post' : 'Posts';
    return count === 1 ? 'Profile' : 'Profiles';
  };

  // Open view more dialog
  const openViewMore = (platform: string, leadType: string = 'all') => {
    const platformLeads = filterLeadsByPlatform(leads, platform, leadType);
    setViewMoreDialog({ open: true, platform, leadType, leads: platformLeads });
  };

  // Group leads by platform
  const leadsByPlatform = leads.reduce((acc, lead) => {
    const platform = lead.platformType || lead.source || 'unknown';
    if (!acc[platform]) acc[platform] = [];
    acc[platform].push(lead);
    return acc;
  }, {} as Record<string, Lead[]>);

  const platforms = Object.keys(leadsByPlatform);
  const emptyState = leadEmptyState(workflowProgress?.status);
  const searchedPlatformCount = workflowProgress?.platforms.length || platforms.length;

  // Group leads by platform AND leadType for distribution
  const leadsByGroup = leads.reduce((acc, lead) => {
    const platform = lead.platformType || lead.source || 'unknown';
    const leadType = lead.leadType || 'profile';
    const key = `${platform}:${leadType}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(lead);
    return acc;
  }, {} as Record<string, Lead[]>);

  const groupKeys = Object.keys(leadsByGroup);

 // Helper to calculate progress percentage for a platform
 const calculateProgress = (platform: PlatformProgress) => {
 if (platform.status === 'completed' || platform.status === 'skipped') return 100;
 if (platform.status === 'pending') return 0;
 if (!platform.maxResults) return 0;
 return Math.min(Math.round((platform.leadsCount / platform.maxResults) * 100), 95);
 };

  const defaultWorkflowProgress = useMemo<WorkflowProgress>(() => {
    const uniquePlatforms = Array.from(
      new Set(leads.map(l => (l.platformType || l.source || 'unknown').toLowerCase()))
    );
    
    // If there are no leads, show a default set of platforms (workflows available)
    const platformList = uniquePlatforms.length > 0 
      ? uniquePlatforms 
      : ['linkedin', 'twitter', 'instagram', 'google-maps', 'facebook'];

    return {
      executionId: '',
      status: 'completed' as const,
      totalLeads: leads.length,
      platforms: platformList.map(p => {
        const matchedLeads = leads.filter(l => matchPlatform(l.platformType || l.source || '', p));
        return {
          platform: p,
          status: matchedLeads.length > 0 ? ('completed' as const) : ('pending' as const),
          leadsCount: matchedLeads.length,
          maxResults: 10,
          leads: matchedLeads,
        };
      }),
    };
  }, [leads]);

  const displayProgress = workflowProgress || defaultWorkflowProgress;

 // Show initial loading state
 if (loading && leads.length === 0) {
 return (
 <LoadingState label="Loading leads..." showLabel className="h-full" />
 );
 }

 if (leadLoadError && leads.length === 0) {
   return (
     <div className="m-4 min-w-0 rounded-xl border border-destructive/25 bg-destructive/5 p-5" role="alert">
       <h3 className="text-sm font-semibold">Saved leads could not be loaded</h3>
       <p className="mt-2 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{leadLoadError}</p>
       <p className="mt-2 text-xs text-muted-foreground">This is a loading error, not an empty search result. Your saved records have not been removed.</p>
       <Button variant="outline" size="sm" className="mt-4" onClick={() => { setLoading(true); void loadLeads(); }}>Retry loading leads</Button>
     </div>
   );
 }

 return (
 <div className={`${styles.panel} h-full overflow-auto p-4 space-y-4 bg-background`}>
 {leadLoadError && <p role="alert" className="rounded-lg border border-destructive/25 p-3 text-sm text-destructive">Refresh failed. Showing the last loaded records. {leadLoadError}</p>}
 {/* POSTS VIEW */}
 {activeView === 'posts' && (
 <div className="space-y-10">
 {/* Posts Header */}
 <div className={styles.header}>
 <div>
 <div className="flex items-center gap-2 mb-2">
 <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-lg">Content Library</Badge>
 </div>
 <h2 className="text-sm font-semibold text-foreground">
 Social <span className="text-primary/40 font-light">Posts</span>
 </h2>
 <p className="text-sm text-muted-foreground mt-1 max-w-xl leading-relaxed opacity-60">
 Synced <span className="font-bold text-primary">{posts.length}</span> platform communications.
 </p>
 </div>
 <Button variant="outline" size="sm" onClick={loadPosts} loading={postsLoading} loadingText="Refresh Stream" className="rounded-xl h-8 px-3 border-border/50 shadow font-semibold text-[9px] text-foreground group">
 <Search className="w-4 h-4 mr-2 transition-transform" />
 Refresh Stream
 </Button>
 </div>

 {postsLoading && posts.length === 0 ? (
 <LoadingState label="Loading posts..." showLabel className="py-32" />
 ) : posts.length === 0 ? (
 <div className="flex items-center justify-center py-32">
 <div className="text-center space-y-4">
 <div className="w-12 h-12 rounded-xl bg-muted/20 flex items-center justify-center mx-auto">
 <FileText className="w-10 h-8 text-muted-foreground opacity-40" />
 </div>
 <p className="text-sm font-medium text-muted-foreground">No posts yet</p>
 <p className="text-sm text-muted-foreground max-w-sm">
 Run a post search workflow (Facebook Post Search, Instagram Post Search, or Twitter Post Search) to see posts here.
 </p>
 </div>
 </div>
 ) : (
 <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4 pb-8">
 {posts.map((post) => {
 const content = post.text || post.caption || '';
 const engagement = [
 { icon: Heart, value: post.likesCount, label: 'Likes' },
 { icon: MessageSquare, value: post.commentsCount, label: 'Comments' },
 { icon: Share2, value: (post.sharesCount || 0) + (post.retweetCount || 0), label: 'Shares' },
 { icon: EyeIcon, value: post.viewCount, label: 'Views' },
 ].filter(e => e.value && e.value > 0);
 const colors = getPlatformColor(post.platform);
 return (
 <div
 key={post.id}
 className="group p-5 rounded-xl border border-border/40 bg-card hover:border-primary/40 hover:bg-primary/5 transition-all shadow-sm flex flex-col gap-3.5"
 >
 {/* Platform + Author */}
 <div className="flex items-center justify-between gap-3">
 <div className="flex items-center gap-3">
 <div className={`w-8 h-8 rounded-lg ${colors.bg} flex items-center justify-center text-white shadow-sm`}>
 <PlatformIcon platform={post.platform} className="w-4 h-4" />
 </div>
 <div>
 {post.authorName && (
 <p className="text-xs font-bold text-foreground leading-tight">{post.authorName}</p>
 )}
 {post.authorUsername && (
 <p className="text-[10px] font-medium text-muted-foreground/60">@{post.authorUsername}</p>
 )}
 </div>
 </div>
 {post.postUrl && (
 <a
 href={post.postUrl}
 target="_blank"
 rel="noopener noreferrer"
 onClick={(e) => e.stopPropagation()}
 className="p-2 rounded-xl hover:bg-primary/10 text-muted-foreground/40 hover:text-primary transition-all"
 title="Open post"
 >
 <ExternalLink className="w-3.5 h-3.5" />
 </a>
 )}
 </div>

 {/* Content */}
 {content && (
 <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3 border-l-2 border-primary/20 pl-3">
 {content}
 </p>
 )}

 {/* Search context */}
 {(post.searchQuery || post.searchHashtag) && (
 <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground/50">
 <Search className="w-3 h-3" />
 {post.searchHashtag ? `#${post.searchHashtag}` : post.searchQuery}
 </div>
 )}

 {/* Engagement */}
 {engagement.length > 0 && (
 <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-border/30">
 {engagement.map(({ icon: Icon, value, label }) => (
 <div key={label} className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground/60" title={label}>
 <Icon className="w-3.5 h-3.5 text-primary/40" />
 {value?.toLocaleString()}
 </div>
 ))}
 </div>
 )}
 </div>
 );
 })}
 </div>
 )}
 </div>
 )}

 {/* LEADS VIEW */}
 {activeView === 'leads' && (
 <>
 {/* Header */}
 <div className={styles.header}>
 <div>
 <div className="flex items-center gap-2 mb-2">
 <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-lg">Lead Hub</Badge>
 <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shadow-[0_0_8px_hsl(var(--primary)/0.4)]" />
 </div>
 <p className="text-sm font-semibold">Market Analysis</p>
 <p className="text-sm text-muted-foreground mt-1 max-w-xl leading-relaxed opacity-60">
 <span className="font-bold text-primary">{leads.length}</span> saved leads · <span className="font-bold text-foreground">{searchedPlatformCount}</span> search platform{searchedPlatformCount === 1 ? '' : 's'}.
 </p>
 </div>
 <div className={styles.actions}>
 <Button onClick={handleEnrichAll} variant="outline" size="sm" loading={enrichingAll} loadingText="Enriching..." disabled={leads.length === 0} className="h-8 rounded-md border-primary/30 px-5 text-[9px] font-semibold text-primary transition-colors hover:bg-primary/10 hover:text-primary">
 <Sparkles className="w-4 h-4 mr-2 transition-transform" />
 Enrich Hub
 </Button>
 <Button onClick={handleAddLead} variant="outline" size="sm" className="rounded-xl h-8 px-5 border-border/50 shadow hover:bg-primary/5 hover:text-primary transition-all font-semibold text-[9px] text-foreground group">
 <UserPlus className="w-4 h-4 mr-2 transition-transform" />
 New Profile
 </Button>
 <Button onClick={() => { setImportStep('upload'); setImportFile(null); setImportLeads([]); setImportError(null); setImportDialogOpen(true); }} variant="outline" size="sm" className="rounded-xl h-8 px-5 border-border/50 shadow hover:bg-primary/5 hover:text-primary transition-all font-semibold text-[9px] text-foreground group">
 <FileSpreadsheet className="w-4 h-4 mr-2 transition-transform" />
 Import
 </Button>
 <Button onClick={handleExport} size="sm" className="rounded-xl h-8 bg-primary text-primary-foreground hover:opacity-90 font-semibold text-[9px] shadow-sm shadow-primary/5 px-3 transition-all flex items-center gap-2">
 <Download className="w-4 h-4" />
 Export Data
 </Button>
 </div>
 </div>

 {/* Summary */}
 {leads.length > 0 && (
 <div className={styles.leadSummary}>
 <div className="border border-border/40 bg-card p-6 rounded-xl relative overflow-hidden group shadow-sm flex flex-col justify-between">
 <div className="relative z-10">
 <div className="flex items-center justify-between gap-3 mb-4">
 <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
 <Activity className="w-6 h-6 text-primary" />
 </div>
 <button
 onClick={() => {
 const allPlatform = platforms[0];
 if (allPlatform) openViewMore(allPlatform);
 }}
 className="text-xs text-primary hover:text-primary/70 transition-colors bg-primary/5 px-3 py-1.5 rounded-lg"
 >
 View All
 </button>
 </div>
 <div className="space-y-3">
 <div className="space-y-1">
 <p className="text-xs text-muted-foreground/60">Total Leads</p>
 <p className="text-2xl font-bold text-foreground tabular-nums">{leads.length}</p>
 </div>
 <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/20">
 {(() => {
   const pCount = leads.filter(l => (l.leadType || 'profile') === 'profile').length;
   const cCount = leads.filter(l => l.leadType === 'company').length;
   const bCount = leads.filter(l => l.leadType === 'place' || l.leadType === 'local_business').length;
   const aCount = leads.filter(l => l.leadType === 'author').length;
   const coCount = leads.filter(l => l.leadType === 'commenter').length;
   const lCount = leads.filter(l => l.leadType === 'liker').length;
   const pgCount = leads.filter(l => l.leadType === 'page').length;
   const oCount = leads.length - pCount - cCount - bCount - aCount - coCount - lCount - pgCount;
   return (
     <>
       {pCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-primary/20 bg-primary/5 text-primary">
           {pCount} Profile{pCount !== 1 ? 's' : ''}
         </Badge>
       )}
       {cCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-blue-500/20 bg-blue-50/50 text-blue-600 dark:text-blue-400">
           {cCount} Compan{cCount !== 1 ? 'ies' : 'y'}
         </Badge>
       )}
       {bCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-emerald-500/20 bg-emerald-50/50 text-emerald-600 dark:text-emerald-400">
           {bCount} Business{bCount !== 1 ? 'es' : ''}
         </Badge>
       )}
       {aCount > 0 && (
         <Badge variant="outline" className="rounded-md border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
           {aCount} Author{aCount !== 1 ? 's' : ''}
         </Badge>
       )}
       {coCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-amber-500/20 bg-amber-50/50 text-amber-600 dark:text-amber-400">
           {coCount} Commenter{coCount !== 1 ? 's' : ''}
         </Badge>
       )}
       {lCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-rose-500/20 bg-rose-50/50 text-rose-600 dark:text-rose-400">
           {lCount} Liker{lCount !== 1 ? 's' : ''}
         </Badge>
       )}
       {pgCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-sky-500/20 bg-sky-50/50 text-sky-600 dark:text-sky-400">
           {pgCount} Page{pgCount !== 1 ? 's' : ''}
         </Badge>
       )}
       {oCount > 0 && (
         <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border-gray-500/20 bg-gray-50/50 text-gray-600 dark:text-gray-400">
           {oCount} Other{oCount !== 1 ? 's' : ''}
         </Badge>
       )}
     </>
   );
 })()}
 </div>
 </div>
 </div>
 </div>

 <div className="min-w-0 border border-border/40 bg-card p-6 rounded-xl shadow-sm relative overflow-hidden">
 <h3 className="text-[9px] font-semibold text-foreground uppercase mb-4 flex items-center gap-2.5">
 <Sparkles className="w-4 h-4 text-primary" />
 Lead Distribution
 </h3>
 <div className="relative z-10 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
 {groupKeys.map((groupKey) => {
 const [platform, leadType] = groupKey.split(':');
 const count = leadsByGroup[groupKey]?.length || 0;
 const colors = getPlatformColor(platform);
 const typeLabel = formatLeadTypeLabel(leadType, count);
 return (
 <button
 key={groupKey}
 type="button"
 onClick={() => openViewMore(platform, leadType)}
 className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-secondary/30 p-4 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
 >
 <div className={`w-10 h-8 rounded-lg ${colors.bg} flex items-center justify-center text-white flex-shrink-0 shadow transition-transform`}>
 {leadType === 'company' ? (
   <Building2 className="w-5 h-5 text-white" />
 ) : leadType === 'commenter' ? (
   <MessageSquare className="w-5 h-5 text-white" />
 ) : leadType === 'liker' ? (
   <Heart className="w-5 h-5 text-white" />
 ) : (
   <PlatformIcon platform={platform} className="w-5 h-5" />
 )}
 </div>
 <div className="min-w-0 flex-1">
 <p className="text-xs text-muted-foreground/60 group-hover:text-primary transition-colors capitalize">{platform}</p>
 <div className="flex items-baseline gap-1">
 <p className="text-sm font-semibold text-foreground truncate">{count}</p>
 <p className="text-[10px] font-semibold opacity-30 uppercase">{typeLabel}</p>
 </div>
 </div>
 </button>
 );
 })}
 </div>
 </div>
 </div>
 )}

 {/* Generation Status */}
 {workflowProgress?.status === 'running' ? (
  <div className="border border-border/40 bg-card p-6 rounded-xl relative overflow-hidden group shadow-sm">
  <div className="relative z-10 flex flex-col justify-between gap-4">
  <div className="flex min-w-0 items-center gap-6 flex-1">
  <div className="relative">
  <div className="w-14 h-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shadow">
  <Spinner size="lg" label={null} className="text-primary" />
  </div>
  <div className="absolute -top-1 -right-1 w-4 h-4 bg-primary rounded-full border-2 border-background animate-pulse shadow-[0_0_12px_hsl(var(--primary)/0.4)]" />
  </div>
  <div className="min-w-0 flex-1">
  <div className="flex flex-wrap items-center gap-3 mb-1.5">
  <Badge variant="outline" className="text-xs px-2.5 py-0.5 border-primary/30 bg-primary/10 text-primary rounded-lg shadow-sm">Active Status</Badge>
  <div className="w-1 h-1 rounded-full bg-primary/40" />
  <p className="text-sm font-semibold">
  Syncing from {currentPlatform || 'multiple sources'}...
  </p>
  </div>
  <p className="text-xs text-muted-foreground/40">
   {leads.length > 0 ? `${leads.length} profiles found` : 'Syncing platforms...'}
  </p>
  </div>
  </div>

  <div className="flex items-center gap-4 flex-shrink-0 self-start">
  {workflowProgress?.totalLeads > 0 && (
  <div className="text-right px-6 py-2 rounded-xl bg-card border border-border/40 shadow-sm">
  <p className="text-[10px] text-muted-foreground/60 mb-0.5">Target</p>
  <p className="text-sm font-semibold text-primary tabular-nums">{workflowProgress.totalLeads}</p>
  </div>
  )}
  <div className="flex items-center gap-2">
  <Button 
  variant="outline" 
  size="sm" 
  onClick={handleCancelPlatform} 
  disabled={cancelling}
  className="text-xs border-primary/20 text-primary hover:bg-primary/5 h-8 rounded-lg font-semibold"
  >
  Skip Platform
  </Button>
  <Button 
  variant="destructive" 
  size="sm" 
  onClick={handleStopAllWorkflows} 
  disabled={cancelling}
  className="text-xs h-8 rounded-lg font-semibold"
  >
  Stop Generation
  </Button>
  </div>
  </div>
  </div>
  </div>
  ) : leads.length === 0 ? (
  <div className="border border-border/40 bg-card p-6 rounded-xl relative overflow-hidden group shadow-sm">
  <div className="relative z-10 flex min-w-0 flex-col gap-6">
  <div className="flex min-w-0 flex-col items-start gap-3">
  <div className="relative shrink-0">
  <div className="w-14 h-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shadow">
  <Bot className="w-6 h-6 text-primary" />
  </div>
  </div>
  <div className="min-w-0 w-full">
  <div className="flex flex-col items-start gap-3 mb-1.5">
  <Badge variant="outline" className="text-xs px-2.5 py-0.5 border-primary/30 bg-primary/10 text-primary rounded-lg shadow-sm font-semibold">{emptyState.badge}</Badge>
  <p className="w-full whitespace-normal [overflow-wrap:normal] [word-break:normal] text-sm font-semibold text-foreground">
  {emptyState.title}
  </p>
  </div>
  <p className="text-xs text-muted-foreground/60 leading-relaxed">
  {emptyState.description}
  </p>
  </div>
  </div>

  <div className="flex min-w-0 flex-wrap items-center gap-3 self-start">
  <Button 
  onClick={handleAddLead} 
  variant="outline"
  size="sm" 
  className="text-xs border-primary/20 text-primary hover:bg-primary/5 h-8 rounded-lg font-semibold"
  >
  <UserPlus className="w-4 h-4 mr-2" />
  Add Lead Manually
  </Button>
  <Button 
  variant="outline" 
  size="sm" 
  onClick={() => { setImportStep('upload'); setImportFile(null); setImportLeads([]); setImportError(null); setImportDialogOpen(true); }}
  className="text-xs h-8 rounded-lg font-semibold"
  >
  <FileSpreadsheet className="w-4 h-4 mr-2" />
  Import CSV/Excel
  </Button>
  </div>
  </div>
  </div>
  ) : null}

  <div className="mt-4 grid grid-cols-1 gap-4 pb-6">
  {(displayProgress?.platforms || []).map((platformData) => {
    const colors = getPlatformColor(platformData.platform);
    const platformLeads = leads.filter((l) => matchPlatform(l.platformType || l.source || '', platformData.platform));
    const progress = calculateProgress(platformData);
    const availableTypes = Array.from(new Set(platformLeads.map(l => l.leadType || 'profile')));
    const activeFilter = platformFilters[platformData.platform.toLowerCase()] || 'all';
    
    const filteredPlatformLeads = platformLeads.filter(l => {
      if (activeFilter === 'all') return true;
      const lt = l.leadType || 'profile';
      return lt.toLowerCase() === activeFilter.toLowerCase();
    });
    
    const displayLeads = filteredPlatformLeads.slice(0, 12);
    const hasMore = filteredPlatformLeads.length > 12;

    return (
      <div key={platformData.platform} className="border border-border/40 bg-card rounded-xl shadow-sm overflow-hidden group/card transition-all hover:bg-card">
        <div className={`${styles.platformHeader} ${colors.light} border-b border-border/40 p-4 relative overflow-hidden`}>
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-16 -mt-16 blur-2xl opacity-50" />
          <div className="flex items-center gap-4 relative z-10">
            <div className={cn(
              "w-10 h-10 shrink-0 rounded-lg flex items-center justify-center text-white shadow-sm transition-all duration-200 group-hover/card:scale-110",
              colors.bg
            )}>
              <PlatformIcon platform={platformData.platform} className="w-7 h-7" />
            </div>
            <div>
              <h4 className="text-sm font-semibold capitalize flex flex-wrap items-center gap-2">
                {leadPlatformLabel(platformData.platform)}
                <Badge variant="outline" className="rounded-lg px-2.5 py-0.5 text-[9px] font-semibold border-primary/20 bg-primary/10 text-primary">
                  {activeFilter !== 'all' ? `${filteredPlatformLeads.length} / ` : ''}{platformLeads.length} Lead{platformLeads.length !== 1 ? 's' : ''}
                </Badge>
              </h4>
              {platformData.status === 'running' && (
                <div className="flex items-center gap-2 mt-1 px-1">
                  <div className="w-1 h-1 rounded-full bg-primary animate-pulse" />
                  <p className="text-[10px] text-muted-foreground font-semibold uppercase opacity-40">
                    Syncing...
                  </p>
                </div>
              )}
              {platformData.status === 'skipped' && (
                <div className="mt-1 flex items-center gap-2 px-1">
                  <p className="text-[10px] font-semibold uppercase text-muted-foreground/60">
                    Skipped · global limit reached
                  </p>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex flex-wrap items-center justify-between gap-3 relative z-10">
            <div className="text-center group/stat">
              <p className="text-xs text-muted-foreground mb-0.5">Saved leads</p>
              <p className="text-sm font-semibold tabular-nums">{platformLeads.length}</p>
            </div>
            <div className="text-right whitespace-nowrap">
              <p className="text-xs text-muted-foreground mb-0.5">Search status</p>
              <p className="text-sm font-semibold text-foreground tabular-nums capitalize">{platformData.status === 'running' ? `${Math.round(progress)}%` : platformData.status}</p>
            </div>
            
            <div className="flex items-center gap-2">
              {platformData.status === 'running' && (
                <div className="w-12 h-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shadow">
                  <Spinner size="md" label="Syncing" className="text-primary" />
                </div>
              )}
              {platformData.status === 'completed' && (
                <div className="w-12 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 shadow">
                  <CheckCircle className="w-5 h-5 text-emerald-500" />
                </div>
              )}
              {platformData.status === 'skipped' && (
                <div className="flex h-9 w-12 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 shadow">
                  <CheckCircle className="h-5 w-5 text-amber-500" />
                </div>
              )}
              {platformData.status === 'error' && (
                <div className="w-12 h-9 rounded-lg bg-destructive/10 flex items-center justify-center border border-destructive/20 shadow">
                  <AlertCircle className="w-5 h-5 text-destructive" />
                </div>
              )}
              <button
                type="button"
                onClick={() => openViewMore(platformData.platform, activeFilter)}
                className="w-12 h-9 rounded-lg bg-card flex items-center justify-center border border-border/40 hover:bg-card hover:border-primary/40 transition-all text-muted-foreground hover:text-primary shadow-sm"
                aria-label={`View all ${leadPlatformLabel(platformData.platform)} leads`}
              >
                <MoreVertical className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
        
        <div className="p-4 sm:p-6">
          {platformData.status === 'running' && platformLeads.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-center space-y-6">
              <div className="w-14 h-14 rounded-xl bg-primary/5 flex items-center justify-center relative">
                <div className="absolute inset-0 rounded-xl border-2 border-primary/20 border-t-primary animate-spin" />
                <Bot className="w-10 h-8 text-primary/60" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">Starting Search</p>
                <p className="text-sm text-muted-foreground max-w-[280px] leading-relaxed">Connecting to {leadPlatformLabel(platformData.platform)} and searching for leads...</p>
              </div>
            </div>
          ) : platformData.status === 'error' ? (
            <div className="flex min-w-0 flex-col items-center space-y-4 overflow-hidden rounded-xl border border-destructive/10 bg-destructive/5 p-4 text-center sm:p-6">
              <div className="w-9 h-9 rounded-lg bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-destructive" />
              </div>
              <div className="w-full min-w-0 max-w-2xl space-y-2">
                <p className="text-sm font-semibold text-destructive">Error</p>
                <p className="w-full break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere] sm:text-[15px]">{platformData.error || 'There was an error searching for leads on this platform.'}</p>
              </div>
              <Button 
                variant="outline" 
                size="lg" 
                onClick={() => handleRetry(platformData.platform)}
                disabled={retrying}
                className="h-8 shrink-0 rounded-lg border-destructive/20 text-xs text-destructive hover:bg-destructive/10"
              >
                <RotateCcw className="w-4 h-4 mr-3" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              {availableTypes.length > 1 && (
                <div className="flex flex-wrap gap-2 mb-6 border-b border-border/20 pb-4">
                  <Button
                    variant={activeFilter === 'all' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPlatformFilters(prev => ({ ...prev, [platformData.platform.toLowerCase()]: 'all' }))}
                    className="h-8 rounded-lg text-xs"
                  >
                    All ({platformLeads.length})
                  </Button>
                  {availableTypes.map(type => {
                    const typeCount = platformLeads.filter(l => (l.leadType || 'profile') === type).length;
                    if (typeCount === 0) return null;
                    return (
                      <Button
                        key={type}
                        variant={activeFilter === type ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setPlatformFilters(prev => ({ ...prev, [platformData.platform.toLowerCase()]: type }))}
                        className="h-8 rounded-lg text-xs capitalize"
                      >
                        {formatLeadTypeLabel(type, typeCount)} ({typeCount})
                      </Button>
                    );
                  })}
                </div>
              )}

              {displayLeads.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center opacity-70">
                  <p className="text-sm font-semibold text-foreground/80 mb-1">
                    {platformData.status === 'pending' ? 'Search Ready' : 'No Leads Found'}
                  </p>
                  <p className="text-xs text-muted-foreground/60 max-w-[280px]">
                    {platformData.status === 'pending'
                      ? 'No leads generated yet. Start a lead generation campaign in chat to scrape leads from this platform.'
                      : 'No leads found on this platform matching your criteria.'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4">
                  {displayLeads.map((lead) => (
                    <LeadPreviewCard key={lead.id} lead={lead} onClick={() => {
                      setSelectedLeadForDetail(lead);
                      setLeadDetailOpen(true);
                    }} _onEnrich={(id: number) => handleEnrichLead(id)} isEnriching={enrichingLeadIds.has(lead.id)} />
                  ))}
                </div>
              )}
              
              {hasMore && (
                <div className="flex justify-center pt-4">
                  <Button
                    variant="ghost" 
                    size="lg" 
                    onClick={() => openViewMore(platformData.platform, activeFilter)}
                    className="rounded-lg text-primary hover:bg-primary/10 transition-colors px-4 h-8 text-xs border border-border/40"
                  >
                    View All {formatLeadTypeLabel(activeFilter, filteredPlatformLeads.length)} ({filteredPlatformLeads.length})
                    <ChevronRight className="w-5 h-5 ml-2 group-hover:translate-x-1.5 transition-transform" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        
        {platformData.status === 'running' && (
          <div className="h-2 w-full bg-muted/30">
            <div 
              className="relative h-full bg-primary transition-[width] duration-200 ease-out"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute inset-x-0 bottom-0 top-0 bg-white/40 animate-[pulse_2s_infinite]" />
            </div>
          </div>
        )}
      </div>
    );
  })}
  </div>

 {/* View More Dialog */}
 <Dialog open={viewMoreDialog.open} onOpenChange={(open) => setViewMoreDialog(prev => ({ ...prev, open }))}>
 <DialogContent className="max-w-6xl h-[85vh] p-0 overflow-hidden border-primary/20 shadow-sm rounded-xl">
 <DialogHeader className="p-8 border-b border-border/50 bg-primary/5">
 <div className="flex items-center justify-between gap-6">
 <div className="flex items-center gap-4">
 <div className={`w-9 h-9 rounded-lg ${getPlatformColor(viewMoreDialog.platform).bg} flex items-center justify-center text-white shadow-sm`}>
 <PlatformIcon platform={viewMoreDialog.platform} className="w-7 h-7" />
 </div>
 <div>
 <DialogTitle className="text-base font-semibold capitalize">
 {leadPlatformLabel(viewMoreDialog.platform)} {viewMoreDialog.leadType === 'all' ? 'Leads' : formatLeadTypeLabel(viewMoreDialog.leadType, viewMoreDialog.leads.length)}
 </DialogTitle>
 <p className="text-sm text-muted-foreground mt-1 font-medium">
 List of all leads found on this platform.
 </p>
 </div>
 </div>
 <Badge variant="outline" className="rounded-full px-6 py-2 text-sm font-bold border-primary/20 bg-primary/5 text-primary shadow shadow-primary/5">
 {viewMoreDialog.leads.length} {viewMoreDialog.leadType === 'all' ? 'Leads' : formatLeadTypeLabel(viewMoreDialog.leadType, viewMoreDialog.leads.length)}
 </Badge>
 </div>
 </DialogHeader>
 
 <ScrollArea className="flex-1 p-8">
 <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4">
 {viewMoreDialog.leads.map((lead) => (
 <LeadPreviewCard 
 key={lead.id} 
 lead={lead} 
 onClick={() => {
 setSelectedLeadForDetail(lead);
 setLeadDetailOpen(true);
 }}
 _onEnrich={(id: number) => handleEnrichLead(id)}
 isEnriching={enrichingLeadIds.has(lead.id)}
 />
 ))}
 </div>
 {viewMoreDialog.leads.length === 0 && (
 <div className="flex flex-col items-center justify-center py-24 text-center space-y-4 opacity-50">
 <div className="w-20 h-20 rounded-xl bg-muted/20 flex items-center justify-center">
 <Bot className="w-10 h-8" />
 </div>
 <p className="text-sm font-medium text-muted-foreground">No profiles found yet</p>
 </div>
 )}
 </ScrollArea>
 
 <div className="p-4 border-t border-border/50 bg-secondary/20 flex justify-end">
 <Button variant="outline" size="lg" onClick={() => setViewMoreDialog(prev => ({ ...prev, open: false }))} className="rounded-xl h-9 border-border/50 font-bold px-10">
 Close
 </Button>
 </div>
 </DialogContent>
 </Dialog>

 {/* Lead Detail Sheet */}
 <LeadDetailSheet
 lead={selectedLeadForDetail}
 open={leadDetailOpen}
 onOpenChange={(open) => {
 setLeadDetailOpen(open);
 if (!open) setSelectedLeadForDetail(null);
 }}
 threadId={threadId}
 outreachLocked={isLeadOutreachLocked(threadId, {
 ...leadReviewState,
 // Live/saved workflow progress can arrive before the chat-state projection.
 // Never expose outreach during that propagation gap.
 workflowExecuted: leadReviewState.workflowExecuted || Boolean(workflowProgress),
 })}
 onEdit={(lead) => router.push(`/dashboard/leads/edit/${lead.id}`)}
 onDelete={async (lead) => {
 try {
 await api.delete(`/api/leads/${lead.id}`);
 toast({ title: 'Lead deleted successfully' });
 setLeadDetailOpen(false);
 loadLeads();
 } catch {
 toast({ title: 'Failed to delete lead', variant: 'destructive' });
 }
 }}
 />

 {/* Instagram DM Modal */}
 <InstagramDMModal
 open={instagramDMModalOpen}
 onOpenChange={(open) => {
 setInstagramDMModalOpen(open);
 if (!open) setSelectedLeadsForModal([]);
 }}
 leads={selectedLeadsForModal.map(lead => ({
 id: lead.id || 0,
 name: lead.name || undefined,
 fullName: lead.name || undefined,
 firstName: lead.name?.split(' ')[0],
 lastName: lead.name?.split(' ').slice(1).join(' '),
 company: lead.company || undefined,
 companyName: lead.company || undefined,
 role: lead.role || undefined,
 }))}
 />

 {/* Send Email Modal */}
 <SendEmailModal
 open={sendEmailModalOpen}
 onOpenChange={(open) => {
 setSendEmailModalOpen(open);
 if (!open) setSelectedLeadsForModal([]);
 }}
 leads={selectedLeadsForModal.map(lead => ({
 id: lead.id || 0,
 name: lead.name || undefined,
 fullName: lead.name || undefined,
 firstName: lead.name?.split(' ')[0],
 lastName: lead.name?.split(' ').slice(1).join(' '),
 email: lead.email || undefined,
 company: lead.company || undefined,
 companyName: lead.company || undefined,
 role: lead.role || undefined,
 }))}
 />

 {/* Import CSV/Excel Dialog */}
 <Dialog open={importDialogOpen} onOpenChange={(open) => { setImportDialogOpen(open); if (!open) { setImportStep('upload'); setImportFile(null); setImportLeads([]); setImportError(null); } }}>
 <DialogContent className="max-w-2xl p-0 overflow-hidden border-primary/20 shadow-sm rounded-xl">
 <DialogHeader className="p-8 border-b border-border/50 bg-primary/5">
 <div className="flex items-center gap-4">
 <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
 <FileUp className="w-7 h-7" />
 </div>
 <div>
 <DialogTitle className="text-base font-semibold">Import Leads</DialogTitle>
 <div className="flex items-center gap-2 mt-1">
 <p className="text-sm text-muted-foreground font-medium">Import lead data from a CSV or Excel file.</p>
 <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase bg-primary/5 border-primary/20 text-primary">
 Step {importStep === 'upload' ? 1 : 2} of 2
 </Badge>
 </div>
 </div>
 </div>
 </DialogHeader>

 {/* Step 1 — Upload */}
 {importStep === 'upload' && (
 <div className="p-4 space-y-6">
 <div 
 className="group border-2 border-dashed border-border/50 rounded-xl p-12 text-center hover:border-primary/40 hover:bg-primary/5 transition-all duration-300 cursor-pointer relative"
 onDragOver={(e) => { e.preventDefault(); setImportDragging(true); }}
 onDragLeave={() => setImportDragging(false)}
 onDrop={(e) => { 
 e.preventDefault(); 
 setImportDragging(false); 
 const f = e.dataTransfer.files[0]; 
 if (f) handleImportFileSelect(f); 
 }}
 onClick={() => document.getElementById('import-file-input')?.click()}
 >
 <input 
 type="file" 
 id="import-file-input"
 className="hidden" 
 accept=".csv,.xls,.xlsx"
 onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFileSelect(f); }}
 />
 <div className="w-20 h-20 bg-primary/5 rounded-xl flex items-center justify-center mx-auto mb-6 transition-transform duration-500">
 <Upload className="w-10 h-8 text-primary/60" />
 </div>
 <div className="space-y-2">
 <p className="text-sm font-medium">Select File</p>
 <p className="text-sm text-muted-foreground max-w-sm mx-auto">Upload your lead list to import them into the system.</p>
 </div>
 {importDragging && (
 <div className="absolute inset-4 rounded-xl border-2 border-primary border-dashed bg-primary/10 flex items-center justify-center z-20 animate-in fade-in zoom-in-95">
 <p className="text-sm font-medium text-primary">Drop to Upload</p>
 </div>
 )}
 </div>

 {importFile && (
 <div className="flex items-center justify-between p-4 rounded-xl bg-primary/5 border border-primary/10 animate-in fade-in slide-in-from-top-2">
 <div className="flex items-center gap-4">
 <div className="w-12 h-9 rounded-lg bg-background flex items-center justify-center text-primary shadow-sm">
 <FileSpreadsheet className="w-6 h-6" />
 </div>
 <div>
 <p className="font-bold text-sm text-foreground">{importFile.name}</p>
 <p className="text-xs font-medium text-muted-foreground/60">{(importFile.size / 1024).toFixed(1)} KB file uploaded</p>
 </div>
 </div>
 <Button variant="ghost" size="icon" onClick={() => setImportFile(null)} className="rounded-xl hover:bg-destructive/10 hover:text-destructive transition-colors">
 <X className="w-4 h-4" />
 </Button>
 </div>
 )}

 {importError && (
 <div className="flex items-center gap-3 p-4 bg-destructive/5 border border-destructive/10 rounded-xl text-sm font-medium text-destructive animate-in shake">
 <AlertCircle className="w-5 h-5 flex-shrink-0" />
 {importError}
 </div>
 )}

 <div className="flex justify-end gap-3 pt-4 border-t border-border/20">
 <Button variant="outline" onClick={() => setImportDialogOpen(false)} className="rounded-xl h-9 px-8 font-bold border-border/50">Cancel</Button>
 <Button 
 onClick={handleImportParse} 
 loading={importParsing}
 loadingText="Analyzing..."
 disabled={!importFile} 
 className="h-9 rounded-md px-10 font-semibold"
 >
 <ChevronRight className="w-4 h-4 mr-2" />
 Next: Preview
 </Button>
 </div>
 </div>
 )}

 {/* Step 2 — Preview */}
 {importStep === 'preview' && (
 <div className="flex flex-col gap-6 p-8 min-h-0 flex-1">
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-4">
 <Badge className="bg-primary/10 text-primary border-none text-xs font-bold px-3 py-1 rounded-full">
 {importLeads.length} Leads Found
 </Badge>
 {importLeads.filter(isMissingImportant).length > 0 && (
 <span className="flex items-center gap-1.5 text-amber-500 font-bold text-xs">
 <AlertTriangle className="w-4 h-4" />
 {importLeads.filter(isMissingImportant).length} Incomplete
 </span>
 )}
 </div>
 <span className="text-xs font-medium text-muted-foreground/50">
 Missing values highlighted in <span className="text-amber-500/80">amber</span>
 </span>
 </div>

 <div className="rounded-xl border border-border/50 overflow-hidden bg-secondary/10">
 <ScrollArea className="h-[380px]">
 <Table>
 <TableHeader className="bg-background/50">
 <TableRow className="hover:bg-transparent border-border/30">
 <TableHead className="w-12 text-xs font-medium text-muted-foreground/60 py-4">#</TableHead>
 <TableHead className="text-xs font-medium text-muted-foreground/60">Profile Name</TableHead>
 <TableHead className="text-xs font-medium text-muted-foreground/60">Communication</TableHead>
 <TableHead className="text-xs font-medium text-muted-foreground/60">Organization</TableHead>
 </TableRow>
 </TableHeader>
 <TableBody>
 {importLeads.map((lead, idx) => {
 const name = String(lead.name || `${lead.first_name || lead.firstName || ''} ${lead.last_name || lead.lastName || ''}`.trim() || '');
 const missingImportant = isMissingImportant(lead);
 return (
 <TableRow key={idx} className={`border-border/30 hover:bg-primary/5 transition-colors ${missingImportant ? 'bg-amber-500/5' : ''}`}>
 <TableCell className="text-xs font-bold text-muted-foreground/40 py-4">{idx + 1}</TableCell>
 <TableCell>
 {name ? <span className="text-sm font-bold text-foreground">{name}</span> : <span className="text-xs font-bold text-amber-500/80">Unknown</span>}
 <p className="text-[10px] text-muted-foreground/60 font-medium">{String(lead.role || lead.job_title || 'Lead')}</p>
 </TableCell>
 <TableCell>
 <div className="space-y-0.5">
 {!!lead.email ? <p className="text-xs font-medium text-foreground">{String(lead.email)}</p> : <p className="text-[10px] font-bold text-amber-500/60">No Email</p>}
 {!!lead.phone && <p className="text-[10px] text-muted-foreground/60">{String(lead.phone)}</p>}
 </div>
 </TableCell>
 <TableCell>
 {lead.company ? <span className="text-xs font-bold text-foreground">{String(lead.company)}</span> : <span className="text-[10px] font-bold text-amber-500/60">No Company</span>}
 </TableCell>
 </TableRow>
 );
 })}
 </TableBody>
 </Table>
 </ScrollArea>
 </div>

 <div className="flex justify-between gap-3 pt-6 border-t border-border/20">
 <Button variant="outline" onClick={() => setImportStep('upload')} disabled={importSaving} className="rounded-xl h-9 px-8 font-bold border-border/50">
 <ChevronLeft className="w-4 h-4 mr-2" />
 Upload Different File
 </Button>
 <div className="flex gap-3">
 <Button variant="outline" onClick={() => setImportDialogOpen(false)} disabled={importSaving} className="rounded-xl h-9 px-8 font-bold border-border/50">Cancel</Button>
 <Button 
 onClick={handleImportSave} 
 loading={importSaving}
 loadingText={`Import ${importLeads.length} Leads`}
 disabled={importLeads.length === 0} 
 className="h-9 rounded-md px-10 font-semibold"
 >
 <Save className="w-4 h-4 mr-2" />
 Import {importLeads.length} Leads
 </Button>
 </div>
 </div>
 </div>
 )}
 </DialogContent>
 </Dialog>

 {/* Add Lead Dialog */}
 <Dialog open={addLeadDialogOpen} onOpenChange={setAddLeadDialogOpen}>
 <DialogContent className="max-w-xl p-0 overflow-hidden border-primary/20 shadow-sm rounded-xl">
 <DialogHeader className="p-8 border-b border-border/50 bg-primary/5">
 <div className="flex items-center gap-4">
 <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
 <UserPlus className="w-7 h-7" />
 </div>
 <div>
 <DialogTitle className="text-base font-semibold">Add New Lead</DialogTitle>
 <p className="text-sm text-muted-foreground mt-1 font-medium">Fill in the details for the new lead.</p>
 </div>
 </div>
 </DialogHeader>
 
 <div className="p-4 space-y-6">
 <div className="grid grid-cols-2 gap-6">
 <div className="space-y-2">
 <Label htmlFor="al-firstName" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">First Name</Label>
 <Input
 id="al-firstName"
 placeholder="First Name"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.firstName}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, firstName: e.target.value }))}
 />
 </div>
 <div className="space-y-2">
 <Label htmlFor="al-lastName" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Last Name</Label>
 <Input
 id="al-lastName"
 placeholder="Last Name"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.lastName}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, lastName: e.target.value }))}
 />
 </div>
 </div>
 
 <div className="space-y-2">
 <Label htmlFor="al-email" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Email <span className="text-destructive">*</span></Label>
 <Input
 id="al-email"
 type="email"
 placeholder="email@example.com"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.email}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, email: e.target.value }))}
 />
 </div>
 
 <div className="grid grid-cols-2 gap-6">
 <div className="space-y-2">
 <Label htmlFor="al-company" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Company</Label>
 <Input
 id="al-company"
 placeholder="Organization"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.company}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, company: e.target.value }))}
 />
 </div>
 <div className="space-y-2">
 <Label htmlFor="al-role" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Role</Label>
 <Input
 id="al-role"
 placeholder="Position"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.role}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, role: e.target.value }))}
 />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-6">
 <div className="space-y-2">
 <Label htmlFor="al-phone" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Phone Number</Label>
 <Input
 id="al-phone"
 placeholder="Phone"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.phone}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, phone: e.target.value }))}
 />
 </div>
 <div className="space-y-2">
 <Label htmlFor="al-location" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Location</Label>
 <Input
 id="al-location"
 placeholder="City, Country"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.location}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, location: e.target.value }))}
 />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-6">
 <div className="space-y-2">
 <Label htmlFor="al-website" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Website</Label>
 <Input
 id="al-website"
 placeholder="https://example.com"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.website}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, website: e.target.value }))}
 />
 </div>
 <div className="space-y-2">
 <Label htmlFor="al-linkedin" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">LinkedIn</Label>
 <Input
 id="al-linkedin"
 placeholder="linkedin.com/in/profile"
 className="rounded-xl h-9 border-border/50 focus:border-primary/50 transition-all font-medium"
 value={addLeadForm.linkedin}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, linkedin: e.target.value }))}
 />
 </div>
 </div>
 
 <div className="space-y-2">
 <Label htmlFor="al-notes" className="text-xs font-bold uppercase text-muted-foreground/60 ml-1">Notes</Label>
 <Textarea
 id="al-notes"
 placeholder="Additional notes..."
 rows={3}
 className="rounded-xl border-border/50 focus:border-primary/50 transition-all font-medium p-4 resize-none"
 value={addLeadForm.notes}
 onChange={(e) => setAddLeadForm(prev => ({ ...prev, notes: e.target.value }))}
 />
 </div>
 
 <div className="flex justify-end gap-3 pt-4 border-t border-border/20">
 <Button variant="outline" onClick={() => setAddLeadDialogOpen(false)} disabled={addLeadSaving} className="rounded-xl h-9 px-8 font-bold border-border shadow-sm hover:bg-secondary/50">
 <X className="w-4 h-4 mr-2" />
 Cancel
 </Button>
 <Button 
 onClick={handleAddLeadSubmit} 
 loading={addLeadSaving}
 loadingText="Save Lead"
 className="rounded-xl h-9 px-10 font-bold bg-primary text-primary-foreground shadow-sm shadow-primary/5 transition-all hover:opacity-90"
 >
 <Save className="w-4 h-4 mr-2" />
 Save Lead
 </Button>
 </div>
 </div>
 </DialogContent>
 </Dialog>
 {/* End Leads View */}
 </>
 )}
 </div>
 );
}
