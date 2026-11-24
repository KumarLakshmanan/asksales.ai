import type { AssistantResource } from './outreachAssistants';

export const ASSISTANT_RESOURCE_CATEGORIES = ['knowledge', 'documents', 'galleries', 'playbooks', 'templates', 'tools'] as const;
export type AssistantResourceCategory = typeof ASSISTANT_RESOURCE_CATEGORIES[number];
export interface AssistantPickerItem extends Omit<AssistantResource, 'id'> {
  id: string;
  approvalRequired?: boolean;
  /** Part of the selected role's default tool set. */
  recommended?: boolean;
}
export interface AssistantResourcePage {
  items: AssistantPickerItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
