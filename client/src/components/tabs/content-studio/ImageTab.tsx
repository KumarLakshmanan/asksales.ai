"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import ImageCreator from '@/components/content-studio/creators/ImageCreator';
import { type ContentStudioTabProps as ImageTabProps } from './types';

export default function ImageTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: ImageTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <ImageCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
