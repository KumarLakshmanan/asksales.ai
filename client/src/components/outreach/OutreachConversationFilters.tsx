"use client";

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ConversationDateFilter, ConversationFilters, ConversationStatusFilter } from './conversation-filters';

interface Props {
  filters: ConversationFilters;
  onChange: (filters: ConversationFilters) => void;
}

export function OutreachConversationFilters({ filters, onChange }: Props) {
  return (
    <div className="space-y-2" aria-label="Conversation filters">
      <div className="grid grid-cols-2 gap-2">
        <Select value={filters.status} onValueChange={(value) => onChange({ ...filters, status: value as ConversationStatusFilter })}>
          <SelectTrigger aria-label="Chat status" className="h-8 min-w-0 px-2 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="unread">Unread</SelectItem>
            <SelectItem value="read">Read</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.date} onValueChange={(value) => onChange({ ...filters, date: value as ConversationDateFilter })}>
          <SelectTrigger aria-label="Activity date" className="h-8 min-w-0 px-2 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any date</SelectItem>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="7days">Last 7 days</SelectItem>
            <SelectItem value="30days">Last 30 days</SelectItem>
            <SelectItem value="custom">Custom range</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {filters.date === 'custom' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0 text-[11px] text-muted-foreground">From
            <Input aria-label="From date" type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => onChange({ ...filters, from: event.target.value })} className="mt-1 h-8 min-w-0 px-1 text-xs" />
          </label>
          <label className="min-w-0 text-[11px] text-muted-foreground">To
            <Input aria-label="To date" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => onChange({ ...filters, to: event.target.value })} className="mt-1 h-8 min-w-0 px-1 text-xs" />
          </label>
        </div>
      )}
    </div>
  );
}
