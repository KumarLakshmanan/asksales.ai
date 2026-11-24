import { useEffect, useMemo } from 'react';
import { Sparkles, AlertTriangle, Palette, Image, Mail, MessageSquare, MessageCircle, FileText, Megaphone, Newspaper, Video } from 'lucide-react';
import {  useContentLibrary,
  ContentTabBar,
  ContentTabContent,
  ContentTabType,
} from '@/components/content-library';
import { usePlatformAccess } from '@/hooks/use-platform-access';

// Context determines how content is filtered:
// 'chat_sidebar' - Show only content from current active chat (requires threadId)
// 'campaign_details' - Show only content from current campaign/chat (requires threadId)
// 'template_page' - Show all content created by the user
type ContentContext = 'chat_sidebar' | 'campaign_details' | 'template_page';

const TAB_HEADER_CONFIG: Record<string, { label: string; icon: typeof Sparkles }> = {
  image: { label: 'Images', icon: Image },
  video: { label: 'Videos', icon: Video },
  email: { label: 'Email', icon: Mail },
  sms: { label: 'SMS', icon: MessageSquare },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle },
  social: { label: 'Social Posts', icon: Megaphone },
  social_message: { label: 'Social Messages', icon: MessageCircle },
  ad_copy: { label: 'Ad Copy', icon: Newspaper },
  blog: { label: 'Blog', icon: FileText },
};

interface ContentStudioTabProps {
  icpId?: number;
  businessProfileId?: number;
  threadId?: number;
  context?: ContentContext;
  previewData?: Record<string, unknown>;
  initialTab?: ContentTabType;
  hideTabBar?: boolean;
  onOpenContentTab?: (contentType: ContentTabType) => void;
  onGenerateContent?: (type: string, topic: string) => void;
  onSendMessage?: (message: string) => void;
}

export default function ContentStudioTab({ icpId, businessProfileId, threadId, context = 'template_page', previewData, initialTab = 'all', hideTabBar = false, onOpenContentTab, onSendMessage }: ContentStudioTabProps) {
  const filterByThread = context === 'chat_sidebar' || context === 'campaign_details';
  const platformAccess = usePlatformAccess();
  const contentAccessEnabled = platformAccess.data?.modules.some(
    (module) => module.key === 'content' && module.enabled,
  ) === true;

  const lib = useContentLibrary({
    threadId,
    filterByThread,
    initialTab,
  });

  const memoizedPreviewData = useMemo(() => previewData, [previewData]);

  // Handle preview data navigation and refresh content when new data arrives
  useEffect(() => {
    if (memoizedPreviewData && Object.keys(memoizedPreviewData).length > 0) {
      const requestedType = memoizedPreviewData.type
        || (memoizedPreviewData.initialTab === 'adcopy' ? 'ad_copy' : undefined)
        || (memoizedPreviewData.ad ? 'ad_copy' : undefined)
        || (memoizedPreviewData.post ? 'social' : undefined);
      const type = requestedType as string | undefined;
      if (initialTab === 'all' && type && ['image', 'video', 'email', 'sms', 'whatsapp', 'social', 'social_message', 'ad_copy', 'blog', 'all'].includes(type)) {
        lib.setActiveTab(type as ContentTabType);
      }
      // Invalidate the shared counts cache after confirmed content arrives.
      lib.handleContentCreated();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoizedPreviewData]);

  const headerConfig = !hideTabBar ? (initialTab !== 'all' ? TAB_HEADER_CONFIG[initialTab] : null) : null;
  const HeaderIcon = headerConfig?.icon || Sparkles;

  if (platformAccess.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Checking Content Studio access…</div>;
  }

  if (platformAccess.isError || !contentAccessEnabled) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-center">
          <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-amber-600" />
          <p className="font-medium">Content Studio access required</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This tab uses the Content module. Ask an administrator to enable Content Studio for your account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col bg-background overflow-hidden">
      {/* Decorative background elements */}

      {/* Header - hidden when hideTabBar is true (sub-tab context within conversations) */}
      {!hideTabBar && (
      <header className="border-b border-border/40 bg-card shrink-0">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <HeaderIcon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">{headerConfig?.label ?? 'Content Studio'}</p>
              <p className="text-xs text-muted-foreground">
                {headerConfig ? `${headerConfig.label} library` : 'All content types'}
              </p>
            </div>
          </div>
          {/* Which brand new content here is generated with (this chat's brand, else the default). */}
          {lib.selectedToolkit && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={lib.selectedToolkitSource === 'thread' ? 'Brand chosen for this chat' : 'Your default brand'}>
              <Palette aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Brand: <span className="font-medium text-foreground">{lib.selectedToolkit.name}</span>{lib.selectedToolkitSource === 'default' ? ' (default)' : ''}</span>
            </p>
          )}
        </div>

          {!icpId && (
            <div className="px-4 pb-3">
              <div className="flex items-center gap-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300">
                <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-3.5 h-3.5" />
                </div>
                <div>
                  <p className="text-xs leading-tight">ICP profile required</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Please configure an ICP profile before generating content.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Tab Bar - only shown for the All Content view */}
          {!hideTabBar && (
            <div className="px-4 pb-3">
              <ContentTabBar
                activeTab={lib.activeTab}
                onTabChange={lib.setActiveTab}
                contentCounts={lib.contentCounts}
              />
            </div>
          )}
      </header>
      )}

      {/* Tab Content */}
      {lib.countsError && <div role="alert" className="p-3 text-sm text-destructive">Content counts could not be loaded. <button className="underline" onClick={() => void lib.loadContentCounts()}>Retry</button></div>}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <ContentTabContent
          activeTab={lib.activeTab}
          refreshKey={lib.refreshKey}
          icpId={icpId}
          businessProfileId={businessProfileId}
          brandToolkitId={lib.selectedToolkit?.id}
          threadId={lib.filterThreadId}
          groupByThread={!lib.filterThreadId}
          onContentCreated={lib.handleContentCreated}
          onSendMessage={onSendMessage}
          allViewMode="overview"
          onTabChange={onOpenContentTab || lib.setActiveTab}
          loadingCounts={lib.loadingCounts}
          contentCounts={lib.contentCounts}
        />
      </div>
    </div>
  );
}
