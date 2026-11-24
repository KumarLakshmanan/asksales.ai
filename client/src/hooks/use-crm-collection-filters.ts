"use client";

import { useEffect, useMemo, useState } from 'react';
import type { CrmContactFilters } from '@/lib/crmContactQuery';

/** Text entry waits briefly; stage, assignment and other choices apply immediately. */
export function useCrmCollectionFilters(filters: CrmContactFilters, scope: string) {
  const [text, setText] = useState({ scope, search: filters.search, tag: filters.tag });
  useEffect(() => {
    const timer = window.setTimeout(() => setText({ scope, search: filters.search, tag: filters.tag }), 250);
    return () => window.clearTimeout(timer);
  }, [scope, filters.search, filters.tag]);
  const serialized = JSON.stringify({ ...filters, search: text.scope === scope ? text.search : filters.search, tag: text.scope === scope ? text.tag : filters.tag });
  return useMemo(() => JSON.parse(serialized) as CrmContactFilters, [serialized]);
}
