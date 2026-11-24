"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, IndianRupee, MessageSquareReply, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn, type SortState } from "@/components/ui/data-table";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { PageEmptyState } from "@/components/EmptyState";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { DescriptionList } from "@/components/ui/description-list";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";

type Lead = {
  id: string;
  name: string;
  company: string;
  stage: "New" | "Contacted" | "Qualified" | "Won";
  score: number | null;
  lastTouch: Date | null;
};

const STAGES: Lead["stage"][] = ["New", "Contacted", "Qualified", "Won"];
const FIRST = ["Asha", "Ravi", "Meera", "Arjun", "Priya", "Karthik", "Divya", "Vikram", "Nila", "Suresh"];
const COMPANIES = ["Acme Hotels", "Blue Lotus Travel", "Coastline Resorts", "Deccan Foods", "Everest Logistics", "Fernhill Retail"];

const ALL_LEADS: Lead[] = Array.from({ length: 57 }, (_, i) => ({
  id: `lead-${i + 1}`,
  name: `${FIRST[i % FIRST.length]} ${String.fromCharCode(65 + (i % 26))}.`,
  company: COMPANIES[(i * 7) % COMPANIES.length],
  stage: STAGES[(i * 3) % STAGES.length],
  score: i % 9 === 0 ? null : (i * 37) % 100,
  lastTouch: i % 11 === 0 ? null : new Date(Date.UTC(2026, 9, 1 + (i % 28))),
}));

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

const columns: DataTableColumn<Lead>[] = [
  {
    id: "name",
    header: "Lead",
    sortValue: (lead) => lead.name,
    cell: (lead) => (
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{lead.name}</p>
        {/* The company column hides on phones, so repeat it here. */}
        <p className="truncate text-xs text-muted-foreground md:hidden">{lead.company}</p>
      </div>
    ),
  },
  { id: "company", header: "Company", hideBelow: "md", sortValue: (lead) => lead.company, cell: (lead) => lead.company },
  {
    id: "stage",
    header: "Stage",
    sortValue: (lead) => STAGES.indexOf(lead.stage),
    cell: (lead) => <Badge variant={lead.stage === "Won" ? "default" : "outline"}>{lead.stage}</Badge>,
  },
  {
    id: "score",
    header: "Score",
    align: "right",
    hideBelow: "sm",
    sortValue: (lead) => lead.score,
    cell: (lead) => lead.score ?? <span className="text-muted-foreground">—</span>,
  },
  {
    id: "lastTouch",
    header: "Last touch",
    align: "right",
    hideBelow: "lg",
    sortValue: (lead) => lead.lastTouch,
    cell: (lead) => (lead.lastTouch ? dateFormat.format(lead.lastTouch) : <span className="text-muted-foreground">Never</span>),
  },
];

type Simulated = "live" | "loading" | "error" | "empty";

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border bg-background p-4 sm:p-6" aria-labelledby={`section-${title}`}>
      <header>
        <h2 id={`section-${title}`} className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

function StateSwitcher({ value, onChange }: { value: Simulated; onChange: (value: Simulated) => void }) {
  const options: Simulated[] = ["live", "loading", "error", "empty"];
  return (
    <div role="radiogroup" aria-label="Simulate data state" className="inline-flex flex-wrap gap-1 rounded-xl border bg-muted/40 p-1">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold capitalize text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-sm"
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/** Pretends to be a paginated, searchable API so every state can be exercised. */
function useFakeLeadsQuery(query: string, page: number, pageSize: number, sort: SortState | null, simulated: Simulated) {
  const [result, setResult] = useState<{ rows: Lead[]; total: number } | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (simulated === "loading") {
      setResult(undefined);
      setLoading(true);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      const needle = query.toLowerCase();
      let rows = simulated === "empty" ? [] : ALL_LEADS.filter((l) => `${l.name} ${l.company}`.toLowerCase().includes(needle));
      if (sort) {
        const column = columns.find((c) => c.id === sort.columnId);
        rows = [...rows].sort((a, b) => {
          const av = column?.sortValue?.(a) ?? null;
          const bv = column?.sortValue?.(b) ?? null;
          if (av === null) return bv === null ? 0 : 1;
          if (bv === null) return -1;
          const diff = av instanceof Date && bv instanceof Date ? av.getTime() - bv.getTime() : String(av).localeCompare(String(bv), undefined, { numeric: true });
          return sort.direction === "asc" ? diff : -diff;
        });
      }
      setResult({ rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length });
      setLoading(false);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [query, page, pageSize, sort, simulated, attempt]);

  return { result, loading, retry: () => setAttempt((n) => n + 1) };
}

export function UiKitGallery() {
  const [simulated, setSimulated] = useState<Simulated>("live");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Lead | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [showTrialNotice, setShowTrialNotice] = useState(true);

  const { result, loading, retry } = useFakeLeadsQuery(query, page, pageSize, sort, simulated);
  const statsLoading = simulated === "loading" || result === undefined;
  const wonCount = useMemo(() => ALL_LEADS.filter((l) => l.stage === "Won").length, []);

  const save = () => {
    setSaving(true);
    window.setTimeout(() => setSaving(false), 1500);
  };

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">UI kit</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Shared components in <code className="rounded bg-muted px-1 py-0.5 text-xs">src/components/ui</code>. Switch the data
            state to see how each one handles loading, failures and empty results.
          </p>
        </div>
        <StateSwitcher value={simulated} onChange={(value) => { setSimulated(value); setPage(1); }} />
      </header>

      <Section title="Stat cards" description="KPI tiles with trend direction that knows whether up is good. Skeletons keep the grid from jumping.">
        <StatGrid columns={4}>
          <StatCard loading={statsLoading} label="Leads" icon={<Users />} value={simulated === "empty" ? null : ALL_LEADS.length} delta={{ value: "12%", trend: "up", label: "vs last week" }} />
          <StatCard loading={statsLoading} label="Won" tone="success" value={simulated === "empty" ? null : wonCount} description="Closed this month" />
          <StatCard loading={statsLoading} label="Reply rate" icon={<MessageSquareReply />} value={simulated === "empty" ? null : "18.4%"} delta={{ value: "2.1 pts", trend: "down", label: "vs last week" }} />
          <StatCard loading={statsLoading} label="Cost per lead" icon={<IndianRupee />} value={simulated === "empty" ? null : "₹312"} delta={{ value: "9%", trend: "down", positiveDirection: "down", label: "cheaper" }} />
        </StatGrid>
      </Section>

      <Section title="Search, table and pagination" description="Debounced search, sortable columns, selection, clickable rows and responsive column hiding, wired to a fake server.">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            aria-label="Search leads by name or company"
            placeholder="Search leads…"
            wrapperClassName="sm:max-w-xs"
            loading={loading && result !== undefined}
            onSearch={(value) => { setQuery(value); setPage(1); }}
          />
          {selected.size > 0 ? (
            <div className="flex items-center gap-2" role="toolbar" aria-label="Bulk actions">
              <span className="text-sm text-muted-foreground" aria-live="polite">{selected.size} selected</span>
              <Button size="sm" variant="outline"><Download />Export</Button>
              <Button size="sm" variant="destructive" onClick={() => setSelected(new Set())}><Trash2 />Remove</Button>
            </div>
          ) : null}
        </div>

        <DataTable
          caption="Leads"
          columns={columns}
          data={simulated === "loading" ? undefined : result?.rows}
          getRowId={(lead) => lead.id}
          loading={loading}
          error={simulated === "error" ? "We couldn’t load leads. Check your connection and try again." : undefined}
          onRetry={retry}
          manualSorting
          sort={sort}
          onSortChange={(next) => { setSort(next); setPage(1); }}
          selectedRowIds={selected}
          onSelectedRowIdsChange={setSelected}
          getRowSelectionLabel={(lead) => `Select ${lead.name}`}
          onRowClick={setOpened}
          getRowLabel={(lead) => `Open ${lead.name}`}
          emptyState={
            <PageEmptyState
              compact
              icon={Users}
              title={query ? `No leads match “${query}”` : "No leads yet"}
              description={query ? "Try a different name or company." : "Import a CSV to get started."}
            />
          }
        />

        <Pagination
          page={page}
          pageSize={pageSize}
          totalItems={simulated === "error" ? 0 : result?.total ?? 0}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          itemLabel="leads"
          disabled={loading || simulated === "error"}
          aria-label="Leads pagination"
        />

        {opened ? (
          <p className="text-sm text-muted-foreground" role="status">
            Opened <span className="font-medium text-foreground">{opened.name}</span> from {opened.company}.
          </p>
        ) : null}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Buttons and spinner" description="Loading buttons keep focus and width and ignore repeat clicks.">
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={saving} loadingText="Saving…" onClick={save}>Save changes</Button>
            <Button variant="outline" loading={saving} onClick={save}>Same label while busy</Button>
            <Button variant="outline" size="icon" aria-label="Download report" loading={saving} onClick={save}><Download /></Button>
          </div>
          <div className="flex items-center gap-4 text-muted-foreground">
            <Spinner size="xs" /><Spinner size="sm" /><Spinner size="md" /><Spinner size="lg" /><Spinner size="xl" label="Loading report" />
          </div>
        </Section>

        <Section title="File dropzone" description="Drag or pick files; type, size, emptiness and count are checked before upload.">
          <FileDropzone
            accept=".csv,.xlsx"
            maxSize={5 * 1024 * 1024}
            multiple
            maxFiles={3}
            loading={uploading}
            onFilesAccepted={(files) => {
              setUploading(true);
              window.setTimeout(() => {
                setUploading(false);
                setUploaded((prev) => [...files.map((f) => f.name), ...prev].slice(0, 5));
              }, 1200);
            }}
          />
          <FileDropzone compact accept="image/*" maxSize={2 * 1024 * 1024} label="Upload a logo" onFilesAccepted={(files) => setUploaded((prev) => [files[0].name, ...prev].slice(0, 5))} />
          {uploaded.length > 0 ? (
            <ul className="space-y-1 text-sm" aria-label="Recently uploaded">
              {uploaded.map((name, i) => <li key={`${name}-${i}`} className="truncate text-muted-foreground">✓ {name}</li>)}
            </ul>
          ) : null}
        </Section>
      </div>

      <Section title="Callouts" description="Inline messages that belong to a section. Danger announces itself; tips stay quiet.">
        <div className="grid gap-3 md:grid-cols-2">
          <Callout tone="danger" title="Gmail disconnected" actions={<Button size="sm" variant="outline">Reconnect</Button>}>
            Replies stopped syncing at 10:42. Reconnect to resume the inbox.
          </Callout>
          {showTrialNotice ? (
            <Callout tone="warning" title="Trial ends in 3 days" onDismiss={() => setShowTrialNotice(false)} dismissLabel="Hide trial notice">
              Add a payment method to keep your campaigns running.
            </Callout>
          ) : (
            <Callout tone="neutral" size="sm">Trial notice hidden.</Callout>
          )}
          <Callout tone="success" title="Domain verified">Emails now send from hello@acmehotels.test.</Callout>
          <Callout tone="info">Tip: press <kbd className="rounded border px-1 text-xs">/</kbd> to search from anywhere.</Callout>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Status badges" description="One shared meaning per status word. Text always states the status.">
          <div className="flex flex-wrap gap-2">
            {["draft", "scheduled", "in_progress", "pending_review", "sent", "failed", "something_new"].map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
        </Section>

        <Section title="Copy button" description="Confirms in place and announces the result; works on plain-HTTP staging too.">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-xs">sk_test_51H8xExampleKeyOnly</code>
            <CopyButton value="sk_test_51H8xExampleKeyOnly" label="Copy API key" />
            <CopyButton value="https://example.test/invite/abc" iconOnly label="Copy invite link" />
          </div>
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Description list" description="Semantic label/value pairs; blanks render a dash, not an empty gap.">
          <DescriptionList
            loading={statsLoading}
            items={[
              { label: "Company", value: "Acme Hotels" },
              { label: "Owner", value: "Asha A." },
              { label: "Phone", value: null },
              { label: "Stage", value: <StatusBadge status="qualified" tone="info" /> },
              { label: "Notes", value: "Prefers WhatsApp after 6pm. Asked for group rates for December.", fullWidth: true },
            ]}
          />
          <DescriptionList
            layout="inline"
            loading={statsLoading}
            items={[
              { label: "Plan", value: "Growth" },
              { label: "Billing cycle", value: "Monthly", hint: "Renews 1 Dec" },
              { label: "Credits left", value: "1,240" },
            ]}
          />
        </Section>

        <Section title="Loading state" description="Centred spinner for a section with nothing to show yet.">
          <div className="rounded-xl border"><LoadingState label="Loading campaigns…" showLabel /></div>
        </Section>
      </div>
    </main>
  );
}
