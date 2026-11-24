"use client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import type {
  SupportFilterOptions,
  SupportFilters,
  SupportPagination,
} from "@/lib/support-report";

const selectClass =
  "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function SupportAIFilters({
  value,
  options,
  onChange,
}: {
  value: SupportFilters;
  options?: SupportFilterOptions;
  onChange: (changes: Partial<SupportFilters>) => void;
}) {
  const active = Boolean(
    value.from ||
    value.to ||
    value.source !== "all" ||
    value.teamId ||
    value.assistantId,
  );
  return (
    <section
      aria-label="Filter support activity"
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <label className="grid min-w-0 gap-1.5 text-xs font-medium">
          From (UTC)
          <Input
            type="date"
            aria-label="From date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => onChange({ from: e.target.value })}
            className="min-h-11"
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium">
          To (UTC)
          <Input
            type="date"
            aria-label="To date"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => onChange({ to: e.target.value })}
            className="min-h-11"
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium">
          Conversation source
          <select
            aria-label="Conversation source"
            className={selectClass}
            value={value.source}
            onChange={(e) =>
              onChange({ source: e.target.value as SupportFilters["source"] })
            }
          >
            <option value="all">All conversations</option>
            <option value="widget">Website customers</option>
            <option value="internal">Internal team chats</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium">
          Support team
          <select
            aria-label="Support team"
            className={selectClass}
            value={value.teamId}
            onChange={(e) => onChange({ teamId: e.target.value })}
          >
            <option value="">All teams</option>
            {value.teamId &&
              !options?.teams.some(
                (item) => String(item.id) === value.teamId,
              ) && <option value={value.teamId}>Selected team</option>}
            {options?.teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium">
          Assistant
          <select
            aria-label="Assistant"
            className={selectClass}
            value={value.assistantId}
            onChange={(e) => onChange({ assistantId: e.target.value })}
          >
            <option value="">All assistants</option>
            {value.assistantId &&
              !options?.assistants.some(
                (item) => String(item.id) === value.assistantId,
              ) && (
                <option value={value.assistantId}>Selected assistant</option>
              )}
            {options?.assistants.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-muted-foreground">
          Date ranges include the full day in UTC. Filters apply to counts and
          all pages of results.
        </p>
        {active && (
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                from: "",
                to: "",
                source: "all",
                teamId: "",
                assistantId: "",
              })
            }
            className="min-h-11 text-xs"
          >
            Reset filters
          </Button>
        )}
      </div>
    </section>
  );
}
export function SupportPaginationControls({
  value,
  onPage,
  label,
  busy = false,
}: {
  value: SupportPagination;
  onPage: (page: number) => void;
  label: string;
  busy?: boolean;
}) {
  return (
    <Pagination
      aria-label={`${label} pages`}
      className="border-t border-border px-4 py-3"
      page={value.page}
      pageSize={value.limit}
      totalItems={value.total}
      onPageChange={onPage}
      itemLabel={label.toLowerCase()}
      disabled={busy}
    />
  );
}
