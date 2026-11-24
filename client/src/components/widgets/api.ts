/**
 * Widget API Client
 * API calls for widget state management
 */

import api from '@/lib/api';
import type { WidgetState } from './types';

interface WidgetApiResponse {
  success: boolean;
  widget?: WidgetState;
  widgets?: WidgetState[];
  error?: string;
}

export const widgetApi = {
  /**
   * Get all widgets for a thread
   */
  async getWidgets(threadId: number): Promise<WidgetState[]> {
    const response = await api.get<WidgetApiResponse>(`/api/widgets?threadId=${threadId}`);
    return (response as unknown as WidgetApiResponse).widgets || [];
  },

  /**
   * Auto-save form values
   */
  async updateFormValues(id: number, formValues: Record<string, unknown>): Promise<WidgetState> {
    // Client loading/error state blocks approval, but is not a tool argument
    // and must not contaminate the persisted draft's strict payload schema.
    const persistedValues = Object.fromEntries(Object.entries(formValues)
      .filter(([key]) => key !== '_review_validation_error'));
    const response = await api.patch<WidgetApiResponse>(`/api/widgets/${id}`, { formValues: persistedValues });
    return (response as unknown as WidgetApiResponse).widget as WidgetState;
  },

  /**
   * Submit widget with final values
   */
  async submitWidget(id: number, values: Record<string, unknown>): Promise<WidgetState> {
    const response = await api.post<WidgetApiResponse>(`/api/widgets/${id}/submit`, { values });
    return (response as unknown as WidgetApiResponse).widget as WidgetState;
  },

  /**
   * Close a widget (save as draft)
   */
  async closeWidget(id: number, status: 'draft' | 'cancelled' = 'draft'): Promise<WidgetState> {
    const response = await api.post<WidgetApiResponse>(`/api/widgets/${id}/close`, { status });
    return (response as unknown as WidgetApiResponse).widget as WidgetState;
  },

  /**
   * Reopen a closed widget
   */
  async reopenWidget(id: number): Promise<WidgetState> {
    const response = await api.post<WidgetApiResponse>(`/api/widgets/${id}/reopen`);
    return (response as unknown as WidgetApiResponse).widget as WidgetState;
  },

  /**
   * Delete a widget permanently
   */
  async deleteWidget(id: number): Promise<void> {
    await api.delete(`/api/widgets/${id}`);
  },
};
