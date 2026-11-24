import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users, Mail, ArrowUpRight, ArrowDownRight,
  Minus, Plus, ChevronRight, Building2
} from "lucide-react";
import { api } from "@/lib/api";
import { CreateContactDialog } from "@/components/crm/CreateContactDialog";
import { useCrmConfiguration } from "@/hooks/use-crm-configuration";
import { crmStageBadgeStyle, crmStagesForStatuses } from "@/lib/crm-configuration";
import { crmContactQuery } from "@/lib/crmContactQuery";
import { useRouter } from "next/navigation";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { formatCurrencyAmount } from "@/lib/utils";

interface CRMTabProps {
  threadId?: string;
  onSendMessage?: (message: string) => void;
}

interface CRMContact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string;
  pipelineStatus: string;
  lastSentimentStatus: string | null;
  sentimentScore: number | null;
  dealValue: string | null;
  currency: string;
  businessCategoryName: string | null;
}

const SENTIMENT_CONFIG: Record<string, { icon: typeof ArrowUpRight; color: string }> = {
  positive: { icon: ArrowUpRight, color: "text-emerald-500" },
  negative: { icon: ArrowDownRight, color: "text-rose-500" },
  neutral: { icon: Minus, color: "text-muted-foreground" },
};

export default function CRMTab({ threadId }: CRMTabProps) {
  const router = useRouter();
  const requestVersion = useRef(0);
  const { stages, error: configurationError, reload: reloadConfiguration } = useCrmConfiguration();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<CRMContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const configuredStages = crmStagesForStatuses(stages, contacts.map(contact => contact.pipelineStatus));

  const fetchContacts = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true); setLoadError(null);
    try {
      const data = await api.get<{ contacts: CRMContact[]; total: number; totalPages: number }>(crmContactQuery({ page, limit: 20, search, pipelineStatus: statusFilter, threadId }));
      if (version !== requestVersion.current) return;
      if (page > Math.max(1, data.totalPages)) { setPage(Math.max(1, data.totalPages)); return; }
      setContacts(data.contacts || []); setTotal(data.total || 0);
    } catch (error) {
      if (version === requestVersion.current) setLoadError(error instanceof Error ? error.message : "Failed to fetch contacts");
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [page, search, statusFilter, threadId]);
  useEffect(() => { void fetchContacts(); return () => { requestVersion.current++; }; }, [fetchContacts]);
  useEffect(() => { setPage(1); setShowCreateDialog(false); }, [threadId]);

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">CRM Contacts</p>
            <p className="text-xs text-muted-foreground">{total} profiles{threadId ? " in this campaign" : ""}</p>
          </div>
        </div>
        <Button size="sm" className="h-8 px-3 rounded-lg text-xs gap-1.5"
          onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {/* Search + Filter */}
      <div className="px-3 py-2.5 border-b flex items-center gap-2 shrink-0">
        <SearchInput
          aria-label="Search contacts by name, email or company"
          placeholder="Search by name, email, company..."
          value={search}
          onValueChange={(value) => { setSearch(value); setPage(1); }}
          size="sm"
          wrapperClassName="flex-1"
          className="h-8 rounded-lg border-border/60 text-xs md:text-xs"
        />
        <Select value={statusFilter} onValueChange={value => { setStatusFilter(value); setPage(1); }}>
          <SelectTrigger className="h-8 w-36 rounded-lg border-border/60 text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-lg">
            <SelectItem value="all" className="text-xs">All statuses</SelectItem>
            {configuredStages.map(stage => <SelectItem key={stage.key} value={stage.key} className="text-xs">{stage.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {configurationError && <div role="alert" className="p-3 text-sm text-destructive">{configurationError} <Button size="sm" variant="outline" onClick={reloadConfiguration}>Retry configuration</Button></div>}
      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 border border-border/40 rounded-xl">
                <Skeleton className="w-9 h-9 rounded-lg shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32 rounded" />
                  <Skeleton className="h-3 w-24 rounded" />
                </div>
                <Skeleton className="h-5 w-16 rounded-md" />
              </div>
            ))}
          </div>
        ) : loadError ? <div role="alert" className="p-4 text-sm">{loadError}<Button variant="outline" onClick={() => void fetchContacts()}>Try again</Button></div> : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
              <Users className="w-5 h-5 text-muted-foreground/40" />
            </div>
            <p className="text-sm font-medium">No contacts yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4 max-w-[220px]">
              Add your first contact to start tracking relationships.
            </p>
            <Button size="sm" variant="outline" className="h-8 px-3 rounded-lg text-xs gap-1.5 border-border/60"
              onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-3.5 w-3.5" /> Add Contact
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {contacts.map((contact) => {
              const sentiment = SENTIMENT_CONFIG[contact.lastSentimentStatus || "neutral"] || SENTIMENT_CONFIG.neutral;
              const SentimentIcon = sentiment.icon;
              const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "Unnamed contact";
              return (
                <button key={contact.id} type="button" onClick={() => router.push(`/dashboard/crm/contacts/${contact.id}`)}
                  className="flex w-full text-left items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer group">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-primary">{contactName.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium truncate">{contactName}</p>
                      <SentimentIcon className={`h-3 w-3 shrink-0 ${sentiment.color}`} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                      {contact.company && (
                        <>
                          <Building2 className="h-2.5 w-2.5 text-muted-foreground/60 shrink-0" />
                          <span className="text-xs text-muted-foreground truncate">{contact.company}</span>
                        </>
                      )}
                      {!contact.company && contact.email && (
                        <>
                          <Mail className="h-2.5 w-2.5 text-muted-foreground/60 shrink-0" />
                          <span className="text-xs text-muted-foreground truncate">{contact.email}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge className="text-[10px] rounded-md px-1.5 h-4 border-none" style={crmStageBadgeStyle(configuredStages.find(stage => stage.key === contact.pipelineStatus))}>
                      {configuredStages.find(stage => stage.key === contact.pipelineStatus)?.label || contact.pipelineStatus || contact.status}
                    </Badge>
                    {contact.dealValue && Number(contact.dealValue) > 0 && (
                      <span className="text-xs font-semibold text-emerald-600 tabular-nums">
                        {formatCurrencyAmount(contact.dealValue, contact.currency || "USD")}
                      </span>
                    )}
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 group-hover:translate-x-0.5 transition-transform" />
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
        itemLabel="contacts"
        disabled={loading}
        showEdgeButtons={false}
        className="border-t p-3"
      />
      <CreateContactDialog key={threadId || "global"} open={showCreateDialog} onOpenChange={setShowCreateDialog} chatThreadId={threadId} onCreated={() => { if (page !== 1 || search || statusFilter !== "all") { setPage(1); setSearch(""); setStatusFilter("all"); } else { void fetchContacts(); } }} />
    </div>
  );
}
