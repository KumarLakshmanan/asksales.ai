"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import VideoCreator from '@/components/content-studio/creators/VideoCreator';
import { type ContentStudioTabProps as VideoTabProps } from './types';

export default function VideoTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: VideoTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <VideoCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
