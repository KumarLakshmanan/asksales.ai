"use client";

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Palette } from 'lucide-react';
import api from '@/lib/api';
import { normalizeUploadUrl } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface OutreachBrandOption {
  id: number;
  name: string;
  logoUrl?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

/** The brand an outreach starts with: the chat thread's chosen brand, else the default. */
export function initialOutreachBrandId(toolkits: OutreachBrandOption[], threadSelectedId?: number | null): number | undefined {
  const active = toolkits.filter(item => item.isActive !== false);
  return (threadSelectedId ? active.find(item => item.id === threadSelectedId) : undefined)?.id
    ?? active.find(item => item.isDefault)?.id
    ?? active[0]?.id;
}

export function useOutreachBrandOptions(threadId?: string | number | null) {
  const toolkits = useQuery({
    queryKey: ['content-brand-toolkits'],
    queryFn: () => api.get<OutreachBrandOption[]>('/api/content/brand-toolkits'),
    staleTime: 60_000,
  });
  const thread = useQuery({
    queryKey: ['content-thread-brand', Number(threadId) || null],
    queryFn: () => api.get<{ metadata?: { selectedBrandToolkitId?: number } }>(`/api/chat/threads/${Number(threadId)}`),
    enabled: Number(threadId) > 0,
    staleTime: 60_000,
  });
  const options = useMemo(() => (Array.isArray(toolkits.data) ? toolkits.data : []).filter(item => item.isActive !== false), [toolkits.data]);
  return {
    options,
    initialId: initialOutreachBrandId(options, thread.data?.metadata?.selectedBrandToolkitId),
    ready: toolkits.isSuccess && (!(Number(threadId) > 0) || !thread.isPending),
    isError: toolkits.isError,
  };
}

/**
 * Shows and sets the brand this outreach is sent with. The choice is saved on
 * the outreach, so its follow-ups keep this brand even if the default changes.
 */
export function OutreachBrandSelect({ value, onChange, threadId, disabled }: {
  value?: number; onChange: (id: number | undefined) => void; threadId?: string | number | null; disabled?: boolean;
}) {
  const { options, initialId, ready, isError } = useOutreachBrandOptions(threadId);
  // Pick the starting brand once options load, or replace a brand that is no longer available.
  const needsInitial = ready && initialId !== undefined && (value === undefined || !options.some(item => item.id === value));
  useEffect(() => {
    if (needsInitial) onChange(initialId);
  }, [needsInitial, initialId, onChange]);
  if (isError) return <p role="alert" className="text-xs text-destructive">Brands could not be loaded. Emails use your default brand.</p>;
  if (!options.length) return null;
  const selected = options.find(item => item.id === value);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="outreach-brand" className="flex items-center gap-1.5 text-xs font-medium">
        <Palette aria-hidden="true" className="h-3.5 w-3.5" />Brand
      </Label>
      <Select value={value ? String(value) : undefined} onValueChange={next => onChange(Number(next))} disabled={disabled || !ready}>
        <SelectTrigger id="outreach-brand" className="h-9 w-full sm:w-64" aria-describedby="outreach-brand-help">
          <SelectValue placeholder="Loading brands…" />
        </SelectTrigger>
        <SelectContent>
          {options.map(item => (
            <SelectItem key={item.id} value={String(item.id)}>
              <span className="flex items-center gap-2">
                {item.logoUrl ? <img src={normalizeUploadUrl(item.logoUrl)} alt="" className="h-4 w-4 rounded object-contain" /> : null}
                {item.name}{item.isDefault ? ' (default)' : ''}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id="outreach-brand-help" className="text-xs text-muted-foreground">
        {selected ? `This outreach and its follow-ups use ${selected.name}. Changing the default brand later won't change it.` : 'Choose the brand for this outreach.'}
      </p>
    </div>
  );
}
