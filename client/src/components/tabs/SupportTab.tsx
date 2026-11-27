import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, AlertCircle, Clock, CheckCircle2,
  ChevronRight, CircleDot, LifeBuoy
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { CreateSupportTicketDialog } from "@/components/support/CreateSupportTicketDialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";

interface SupportTabProps {
  threadId?: string;
  onSendMessage?: (message: string) => void;
}

interface SupportTicket {
  id: number;
  ticketNumber: string;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  createdAt: string;
}

const STATUS_CONFIG: Record<string, { icon: typeof CircleDot; color: string }> = {
  open: { icon: AlertCircle, color: "text-red-500" },
  in_progress: { icon: Clock, color: "text-amber-500" },
  waiting_on_customer: { icon: Clock, color: "text-blue-500" },
  resolved: { icon: CheckCircle2, color: "text-emerald-500" },
  closed: { icon: CircleDot, color: "text-slate-400" },
};

// Open tickets need attention in this panel, so they read as danger rather than the app-wide "info".
const TICKET_STATUS_TONES: Record<string, StatusTone> = { open: "danger", waiting_on_customer: "info" };

const PRIORITY_CLASS: Record<string, string> = {
  critical: "bg-red-500/10 text-red-600",
  high: "bg-orange-500/10 text-orange-600",
  medium: "bg-amber-500/10 text-amber-600",
  low: "bg-emerald-500/10 text-emerald-600",
};

function formatDate(str: string) {
  return new Date(str).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function SupportTab({ threadId }: SupportTabProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const requestVersion = useRef(0);

  const fetchTickets = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (threadId) params.set("chatThreadId", threadId);
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const data = await api.get<{ tickets: SupportTicket[]; total: number; totalPages: number }>(`/api/support?${params}`);
      if (version !== requestVersion.current) return;
      if (page > Math.max(1, data.totalPages)) { setPage(Math.max(1, data.totalPages)); return; }
      setTickets(data.tickets || []); setTotal(data.total || 0);
    } catch (error) {
      if (version !== requestVersion.current) return;
      setLoadError(error instanceof Error ? error.message : "Failed to fetch tickets");
      toast({ title: "Error", description: "Failed to fetch tickets", variant: "destructive" });
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [page, search, statusFilter, threadId, toast]);

  useEffect(() => { void fetchTickets(); return () => { requestVersion.current++; }; }, [fetchTickets]);
  useEffect(() => { setPage(1); setShowCreateDialog(false); }, [threadId]);

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Support Tickets</p>
            <p className="text-xs text-muted-foreground">{total} tickets{threadId ? " in this campaign" : ""}</p>
          </div>
        </div>
        <Button size="sm" className="h-8 px-3 rounded-lg text-xs gap-1.5"
          onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-3.5 w-3.5" /> New ticket
        </Button>
      </div>

      {/* Search + Filter */}
      <div className="px-3 py-2.5 border-b flex items-center gap-2 shrink-0">
        <SearchInput
          aria-label="Search support tickets"
          placeholder="Search tickets..."
          value={search}
          onValueChange={(value) => { setSearch(value); setPage(1); }}
          size="sm"
          wrapperClassName="flex-1"
          className="h-8 rounded-lg border-border/60 text-xs md:text-xs"
        />
        <Select value={statusFilter} onValueChange={value => { setStatusFilter(value); setPage(1); }}>
          <SelectTrigger className="h-8 w-32 rounded-lg border-border/60 text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg">
            <SelectItem value="all" className="text-xs">All statuses</SelectItem>
            <SelectItem value="open" className="text-xs">Open</SelectItem>
            <SelectItem value="in_progress" className="text-xs">In Progress</SelectItem>
            <SelectItem value="waiting_on_customer" className="text-xs">Waiting on customer</SelectItem>
            <SelectItem value="resolved" className="text-xs">Resolved</SelectItem>
            <SelectItem value="closed" className="text-xs">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 border border-border/40 rounded-xl">
                <Skeleton className="w-9 h-9 rounded-lg shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-48 rounded" />
                  <Skeleton className="h-3 w-32 rounded" />
                </div>
                <Skeleton className="h-5 w-16 rounded-md" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center" role="alert">
            <AlertCircle className="h-6 w-6 text-destructive mb-3" />
            <p className="text-sm font-medium">Tickets could not be loaded</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => void fetchTickets()}>
              Try again
            </Button>
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
              <LifeBuoy className="w-5 h-5 text-muted-foreground/40" />
            </div>
            <p className="text-sm font-medium">No customer tickets yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4 max-w-[240px]">
              Log a customer's issue from this campaign so your support team can track and answer it.
            </p>
            <Button size="sm" variant="outline" className="h-8 px-3 rounded-lg text-xs gap-1.5 border-border/60"
              onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-3.5 w-3.5" /> New Ticket
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {tickets.map((ticket) => {
              const cfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
              const StatusIcon = cfg.icon;
              return (
                <button key={ticket.id} type="button" onClick={() => router.push(`/dashboard/support/${ticket.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors group">
                  <div className="w-9 h-9 rounded-lg bg-muted/40 flex items-center justify-center shrink-0">
                    <StatusIcon className={`h-4 w-4 ${cfg.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0">{ticket.ticketNumber}</span>
                      <p className="text-sm font-medium truncate">{ticket.subject}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <StatusBadge status={ticket.status} toneOverrides={TICKET_STATUS_TONES} className="h-4 px-1.5 py-0 text-[10px]" />
                      <Badge className={`text-[10px] rounded-md px-1.5 h-4 border-none ${PRIORITY_CLASS[ticket.priority] || "bg-muted text-muted-foreground"}`}>
                        {ticket.priority}
                      </Badge>
                      {ticket.category && (
                        <Badge variant="outline" className="text-[10px] rounded-md px-1.5 h-4 border-border/40">
                          {ticket.category}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />{formatDate(ticket.createdAt)}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Pagination
        page={page}
        pageSize={20}
        totalItems={total}
        onPageChange={setPage}
        itemLabel="tickets"
        disabled={loading}
        showEdgeButtons={false}
        className="border-t p-3"
      />
      <CreateSupportTicketDialog key={threadId || "global"} open={showCreateDialog} onOpenChange={setShowCreateDialog} chatThreadId={threadId} onCreated={() => void fetchTickets()} />
    </div>
  );
}
