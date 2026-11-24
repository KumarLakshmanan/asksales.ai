import { proposalContextQuery } from "@/lib/proposalContextHandoff";
import { useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  FileText, Sparkles, Clock, ChevronRight
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";

interface ProposalsTabProps {
  threadId?: string;
  onSendMessage?: (message: string) => void;
}

interface Proposal {
  id: number;
  proposalNumber: string;
  title: string;
  status: string;
  currency: string;
  total: string;
  validUntil: string | null;
  createdAt: string;
}

// Proposal lifecycle tones where they differ from the app-wide map ("sent" is not the end state here).
const PROPOSAL_STATUS_TONES: Record<string, StatusTone> = {
  delivery_unknown: "warning",
  sending: "warning",
  sent: "info",
  viewed: "progress",
  accepted: "success",
  expired: "warning",
};

const NO_TEMPLATE_VALUE = "__no_template__";

export default function ProposalsTab({ threadId }: ProposalsTabProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [generateForm, setGenerateForm] = useState({ title: "", context: "" });
  const [docTemplates, setDocTemplates] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  useEffect(() => {
    api.get<Array<{ id: number; name: string; templateType: string | null }>>("/api/proposals/templates")
      .then((data) => {
        const docs = (data || []).filter((t) => t.templateType === "document");
        setDocTemplates(docs);
        if (docs.length > 0) setSelectedTemplateId(String(docs[0].id));
      })
      .catch(() => {});
  }, []);

  const fetchProposals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", limit: "50" });
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (threadId) params.set("chatThreadId", threadId);
      const data = await api.get<{ proposals: Proposal[] }>(`/api/proposals?${params}`);
      setProposals(data.proposals || []);
    } catch {
      toast({ title: "Error", description: "Failed to fetch proposals", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, threadId, toast]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  useEffect(() => { setShowGenerateDialog(false); setGenerateForm({ title: "", context: "" }); }, [threadId]);

  const handleGenerate = () => {
    if (!generateForm.title.trim()) return;
    let contextQuery: { context?: string; contextKey?: string };
    try { contextQuery = proposalContextQuery(generateForm.context); }
    catch { toast({ title: "Unable to preserve requirements", description: "Browser session storage is unavailable. Keep this form open and try again.", variant: "destructive" }); return; }
    const query = new URLSearchParams({ title: generateForm.title.trim() });
    for (const [key, value] of Object.entries(contextQuery)) if (value !== undefined) query.set(key, value);
    if (selectedTemplateId) query.set("templateId", selectedTemplateId);
    if (threadId) query.set("chatThreadId", threadId);
    setShowGenerateDialog(false);
    router.push(`/dashboard/proposals/new?${query}`);
  };

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Proposals</p>
            <p className="text-xs text-muted-foreground">{proposals.length} proposals</p>
          </div>
        </div>
        <Button size="sm" className="h-8 px-3 rounded-lg text-xs gap-1.5"
          onClick={() => setShowGenerateDialog(true)}>
          <Sparkles className="h-3.5 w-3.5" /> Create
        </Button>
      </div>

      {/* Search + Filter */}
      <div className="px-3 py-2.5 border-b flex items-center gap-2 shrink-0">
        <SearchInput
          aria-label="Search proposals"
          placeholder="Search proposals..."
          value={search}
          onValueChange={setSearch}
          size="sm"
          wrapperClassName="flex-1"
          className="h-8 rounded-lg border-border/60 text-xs md:text-xs"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-28 rounded-lg border-border/60 text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg">
            <SelectItem value="all" className="text-xs">All</SelectItem>
            <SelectItem value="draft" className="text-xs">Draft</SelectItem>
            <SelectItem value="viewed" className="text-xs">Viewed</SelectItem>
            <SelectItem value="expired" className="text-xs">Expired</SelectItem>
            <SelectItem value="delivery_unknown" className="text-xs">Delivery needs review</SelectItem>
            <SelectItem value="sent" className="text-xs">Sent</SelectItem>
            <SelectItem value="accepted" className="text-xs">Accepted</SelectItem>
            <SelectItem value="rejected" className="text-xs">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="p-4 border border-border/40 rounded-xl space-y-2">
                <div className="flex justify-between">
                  <Skeleton className="h-3.5 w-40 rounded" />
                  <Skeleton className="h-4 w-14 rounded-md" />
                </div>
                <Skeleton className="h-3 w-24 rounded" />
                <Skeleton className="h-3 w-20 rounded" />
              </div>
            ))}
          </div>
        ) : proposals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
              <FileText className="w-5 h-5 text-muted-foreground/40" />
            </div>
            <p className="text-sm font-medium">No proposals yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4 max-w-[220px]">
              Create a proposal in the editor with your campaign context.
            </p>
            <Button size="sm" variant="outline" className="h-8 px-3 rounded-lg text-xs gap-1.5 border-border/60"
              onClick={() => setShowGenerateDialog(true)}>
              <Sparkles className="h-3.5 w-3.5" /> Create Proposal
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {proposals.map((proposal) => (
              <div key={proposal.id} role="link" tabIndex={0} onClick={() => router.push(`/dashboard/proposals/${proposal.id}`)} onKeyDown={(event) => { if (event.key === "Enter") router.push(`/dashboard/proposals/${proposal.id}`); }}
                className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer group">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <FileText className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0">{proposal.proposalNumber}</span>
                    <StatusBadge status={proposal.status} toneOverrides={PROPOSAL_STATUS_TONES} className="h-4 px-1.5 py-0 text-[10px]" />
                  </div>
                  <p className="text-sm font-medium mt-1 truncate">{proposal.title}</p>
                  <div className="flex items-center gap-3 mt-1">
                    {Number(proposal.total) > 0 && (
                      <span className="text-xs font-semibold text-emerald-600 tabular-nums">
                        {proposal.currency} {Number(proposal.total).toLocaleString()}
                      </span>
                    )}
                    {proposal.validUntil && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" /> {new Date(proposal.validUntil).toLocaleDateString()}
                      </span>
                    )}
                    {!proposal.validUntil && (
                      <span className="text-[10px] text-muted-foreground/50">
                        {new Date(proposal.createdAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 mt-2 group-hover:translate-x-0.5 transition-transform" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Generate Dialog */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent className="max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
              </div>
              Create Proposal
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Title *</Label>
              <Input maxLength={500} value={generateForm.title}
                onChange={(e) => setGenerateForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g., Growth Expansion Proposal"
                className="h-9 rounded-lg border-border/60 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Context / Requirements</Label>
              <Textarea maxLength={10000} value={generateForm.context}
                onChange={(e) => setGenerateForm(f => ({ ...f, context: e.target.value }))}
                rows={3} placeholder="Describe requirements, objectives, or constraints..."
                className="rounded-lg border-border/60 text-sm resize-none" />
            </div>
            {docTemplates.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Template</Label>
                <Select
                  value={selectedTemplateId || NO_TEMPLATE_VALUE}
                  onValueChange={(value) => setSelectedTemplateId(value === NO_TEMPLATE_VALUE ? "" : value)}
                >
                  <SelectTrigger className="h-9 rounded-lg border-border/60 text-xs">
                    <SelectValue placeholder="Select template" />
                  </SelectTrigger>
                  <SelectContent className="rounded-lg">
                    <SelectItem value={NO_TEMPLATE_VALUE} className="text-xs">None</SelectItem>
                    {docTemplates.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)} className="text-xs">{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs"
              onClick={() => setShowGenerateDialog(false)}>Cancel</Button>
            <Button size="sm" className="h-8 rounded-lg text-xs gap-1.5"
              onClick={handleGenerate} disabled={!generateForm.title.trim()}>
              <Sparkles className="h-3.5 w-3.5" />
              Open proposal editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
