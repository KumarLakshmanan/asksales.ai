"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import SmsCreator from '@/components/content-studio/creators/SmsCreator';
import { type ContentStudioTabProps as SmsTabProps } from './types';

export default function SmsTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: SmsTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <SmsCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
