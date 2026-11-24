"use client";
import { Button } from "@/components/ui/button";

export function SessionHistoryControls({ search, onSearch, archived, onArchived }: { search: string; onSearch: (value: string) => void; archived: boolean; onArchived: (value: boolean) => void }) {
  return <div className="space-y-2 border-b border-border p-3"><input type="search" aria-label="Search conversations" placeholder="Search conversations…" value={search} onChange={(event) => onSearch(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" /><select aria-label="Conversation filter" value={archived ? "archived" : "active"} onChange={(event) => onArchived(event.target.value === "archived")} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"><option value="active">Active conversations</option><option value="archived">Archived conversations</option></select></div>;
}

export function SessionPagination({ page, hasMore, loading, onPage }: { page: number; hasMore: boolean; loading: boolean; onPage: (page: number) => void }) {
  return <nav aria-label="Conversation pages" className="flex items-center justify-between gap-2 border-t border-border p-3 text-xs"><Button size="sm" variant="ghost" disabled={page === 1 || loading} onClick={() => onPage(page - 1)}>Previous</Button><span>Page {page}</span><Button size="sm" variant="ghost" disabled={!hasMore || loading} onClick={() => onPage(page + 1)}>Next</Button></nav>;
}
