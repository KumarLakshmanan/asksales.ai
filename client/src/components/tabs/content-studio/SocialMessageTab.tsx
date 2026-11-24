"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import DmCreator from '@/components/content-studio/creators/DmCreator';
import { type ContentStudioTabProps as SocialMessageTabProps } from './types';

export default function SocialMessageTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: SocialMessageTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <DmCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
