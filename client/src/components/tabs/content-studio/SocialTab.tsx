"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import SocialCreator from '@/components/content-studio/creators/SocialCreator';
import { type ContentStudioTabProps as SocialTabProps } from './types';

export default function SocialTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: SocialTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <SocialCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
