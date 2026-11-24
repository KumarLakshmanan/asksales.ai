"use client";

import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import BlogCreator from '@/components/content-studio/creators/BlogCreator';
import { type ContentStudioTabProps as BlogTabProps } from './types';

export default function BlogTab({ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }: BlogTabProps) {
  return <CreatorScopeProvider value={{ refreshKey, threadId, icpId, businessProfileId, brandToolkitId, onContentCreated, onSendMessage, onHireAgent }}>
    <BlogCreator key={`${threadId ?? 'library'}:${businessProfileId ?? 'default'}:${brandToolkitId ?? 'default'}`} />
  </CreatorScopeProvider>;
}
