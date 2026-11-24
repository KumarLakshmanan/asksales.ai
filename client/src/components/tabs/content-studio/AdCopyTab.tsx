"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import AdCreator from '@/components/content-studio/creators/AdCreator';
import { type ContentStudioTabProps as AdCopyTabProps } from './types';

export default function AdCopyTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: AdCopyTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <AdCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
