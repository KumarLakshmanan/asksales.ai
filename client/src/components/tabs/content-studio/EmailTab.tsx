"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import EmailCreator from '@/components/content-studio/creators/EmailCreator';
import { type ContentStudioTabProps as EmailTabProps } from './types';

export default function EmailTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: EmailTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <EmailCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
