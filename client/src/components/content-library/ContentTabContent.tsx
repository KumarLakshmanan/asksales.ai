"use client";
import { useEffect, useState, useRef } from 'react';
import { ContentTabType } from './types';
import {
  EmailTab,
  SmsTab,
  SocialTab,
  SocialMessageTab,
  AdCopyTab,
  ImageTab,
  VideoTab,
  BlogTab,
} from '@/components/tabs/content-studio';
import WhatsappTab from '@/components/tabs/content-studio/WhatsappTab';
import ContentAllView from './ContentAllView';
import type { ContentAsset } from './types';

interface ContentTabContentProps {
  activeTab: ContentTabType;
  refreshKey?: number;
  icpId?: number;
  businessProfileId?: number;
  brandToolkitId?: number;
  threadId?: number;
  groupByThread?: boolean;
  hideGenerateButton?: boolean;
  onContentCreated?: () => void;
  onHireAgent?: (agentType: string, prompt: string) => void;
  onSendMessage?: (message: string) => void;
  // All assets view props
  allAssets?: ContentAsset[];
  onDeleteAsset?: (id: number) => void;
  loadingCounts?: boolean;
  contentCounts?: Record<string, number>;
  onTabChange?: (tab: ContentTabType) => void;
  /** render mode for "all" tab: 'cards' renders the asset grid, 'overview' renders the category tiles */
  allViewMode?: 'cards' | 'overview';
}

export default function ContentTabContent({
  activeTab,
  refreshKey = 0,
  icpId,
  businessProfileId,
  brandToolkitId,
  threadId,
  groupByThread,
  hideGenerateButton,
  onContentCreated,
  onHireAgent,
  onSendMessage,
  allAssets = [],
  onDeleteAsset,
  loadingCounts,
  contentCounts,
  onTabChange,
  allViewMode = 'cards',
}: ContentTabContentProps) {
  const [prevTab, setPrevTab] = useState(activeTab);
  const [transitioning, setTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (activeTab !== prevTab) {
      // Clear any existing timeout to handle rapid tab clicks
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
      setTransitioning(true);
      // Reset after a short delay so new tab content can start rendering
      transitionTimeoutRef.current = setTimeout(() => {
        setTransitioning(false);
        setPrevTab(activeTab);
        transitionTimeoutRef.current = null;
      }, 80);
      return () => {
        if (transitionTimeoutRef.current) {
          clearTimeout(transitionTimeoutRef.current);
        }
      };
    }
  }, [activeTab, prevTab]);

  const content = (() => {
  switch (activeTab) {
    case 'image':
      return (
        <ImageTab
          refreshKey={refreshKey}
          key={`image`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          onContentCreated={onContentCreated}
        />
      );
    case 'video':
      return (
        <VideoTab
          refreshKey={refreshKey}
          key={`video`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          onContentCreated={onContentCreated}
        />
      );
    case 'email':
      return (
        <EmailTab
          refreshKey={refreshKey}
          key={`email`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          groupByThread={groupByThread ?? !!threadId}
          hideGenerateButton={hideGenerateButton}
          onContentCreated={onContentCreated}
          onHireAgent={onHireAgent}
          onSendMessage={onSendMessage}
        />
      );
    case 'sms':
      return (
        <SmsTab
          refreshKey={refreshKey}
          key={`sms`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          groupByThread={groupByThread ?? !!threadId}
          hideGenerateButton={hideGenerateButton}
          onContentCreated={onContentCreated}
          onHireAgent={onHireAgent}
          onSendMessage={onSendMessage}
        />
      );
    case 'whatsapp':
      return <WhatsappTab threadId={threadId} refreshKey={refreshKey} hideGenerateButton={hideGenerateButton} onSendMessage={onSendMessage} />;
    case 'social':
      return (
        <SocialTab
          refreshKey={refreshKey}
          key={`social`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          groupByThread={groupByThread ?? !!threadId}
          hideGenerateButton={hideGenerateButton}
          onContentCreated={onContentCreated}
          onHireAgent={onHireAgent}
          onSendMessage={onSendMessage}
        />
      );
    case 'social_message':
      return (
        <SocialMessageTab
          refreshKey={refreshKey}
          key={`social_message`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          groupByThread={groupByThread ?? !!threadId}
          hideGenerateButton={hideGenerateButton}
          onContentCreated={onContentCreated}
          onHireAgent={onHireAgent}
          onSendMessage={onSendMessage}
        />
      );
    case 'ad_copy':
      return (
        <AdCopyTab
          refreshKey={refreshKey}
          key={`ad_copy`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          groupByThread={groupByThread ?? !!threadId}
          hideGenerateButton={hideGenerateButton}
          onContentCreated={onContentCreated}
          onHireAgent={onHireAgent}
          onSendMessage={onSendMessage}
        />
      );
    case 'blog':
      return (
        <BlogTab
          refreshKey={refreshKey}
          key={`blog`}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={brandToolkitId}
          threadId={threadId}
          groupByThread={groupByThread ?? !!threadId}
          hideGenerateButton={hideGenerateButton}
          onContentCreated={onContentCreated}
          onHireAgent={onHireAgent}
          onSendMessage={onSendMessage}
        />
      );
    case 'all':
    default:
      return allViewMode === 'overview' ? (
        <ContentAllView
          mode="overview"
          threadId={threadId}
          onTabChange={onTabChange}
          loadingCounts={loadingCounts}
          contentCounts={contentCounts}
        />
      ) : (
        <ContentAllView
          mode="cards"
          allAssets={allAssets}
          onDeleteAsset={onDeleteAsset}
          loadingCounts={loadingCounts}
        />
      );
  }
  })();

  return (
    <div
      className="h-full min-h-0 min-w-0 overflow-auto transition-opacity duration-100 motion-reduce:transition-none"
      style={{ opacity: transitioning ? 0 : 1 }}
    >
      {content}
    </div>
  );
}
