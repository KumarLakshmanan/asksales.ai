"use client";

import { createContext, useContext } from 'react';

export interface CreatorScope {
  threadId?: number;
  refreshKey?: number;
  icpId?: number;
  businessProfileId?: number;
  brandToolkitId?: number;
  onSendMessage?: (message: string) => void;
  onContentCreated?: () => void;
  onHireAgent?: (agentType: string, prompt: string) => void;
}

const ScopeContext = createContext<CreatorScope>({});
export const CreatorScopeProvider = ScopeContext.Provider;
export function useCreatorScope() { return useContext(ScopeContext); }
export function creatorAssetUrl(type: string, scope: CreatorScope) {
  const query = new URLSearchParams({ type });
  if (scope.threadId) query.set('threadId', String(scope.threadId));
  return `/api/content/assets?${query}`;
}
export function creatorGenerationContext(scope: CreatorScope) {
  return {
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.icpId ? { icpId: scope.icpId } : {}),
  };
}
export function creatorDraftScope(scope: CreatorScope) { return scope.threadId ? `thread-${scope.threadId}` : 'library'; }
