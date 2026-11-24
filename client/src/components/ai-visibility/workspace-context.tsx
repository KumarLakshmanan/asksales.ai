'use client';
import type { AiVisibilityProject, VisibilityOverview } from '@/lib/ai-visibility';
import type { QueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';

export function capabilities(role?: string) {
  return {
    edit: ['owner', 'billing_admin', 'member', 'agency_admin', 'editor'].includes(role || ''),
    bill: ['owner', 'billing_admin', 'member'].includes(role || ''),
    connections: ['owner', 'billing_admin'].includes(role || ''),
    review: ['owner', 'billing_admin', 'member', 'agency_admin', 'editor', 'client_reviewer'].includes(role || ''),
    members: role === 'owner',
  };
}
export function refreshVisibility(client: QueryClient, projectId: number) {
  return client.invalidateQueries({
    predicate: ({ queryKey }) => {
      const key = String(queryKey[0]);
      return (
        key.startsWith('ai-visibility-') &&
        key !== 'ai-visibility-audits' &&
        (queryKey[1] === projectId ||
          ['ai-visibility-projects', 'ai-visibility-website-searches'].includes(key))
      );
    },
  });
}
export const MeasurementContext = createContext<{
  project?: AiVisibilityProject;
  overview?: VisibilityOverview;
  auditId?: number;
  historical: boolean;
  can: ReturnType<typeof capabilities>;
}>({ historical: false, can: capabilities() });
export const useMeasurement = () => useContext(MeasurementContext);
