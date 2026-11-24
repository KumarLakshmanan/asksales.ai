import type { CreatorScope } from '@/components/content-studio/CreatorScope';

/** Props shared by the Content Studio library tabs. */
export interface ContentStudioTabProps extends CreatorScope {
  groupByThread?: boolean;
  hideGenerateButton?: boolean;
  onContentCreated?: () => void;
  onHireAgent?: (agentType: string, prompt: string) => void;
  onSendMessage?: (message: string) => void;
}
