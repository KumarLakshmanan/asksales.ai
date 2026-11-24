import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsQueryWidget } from '@/components/widgets/AnalyticsQueryWidget';
import type { WidgetState } from '@/components/widgets/types';

afterEach(cleanup);
describe('analytics scope review', () => {
  it.each(['current_campaign', 'all_owned'])('retains model-selected %s scope in reviewed values', scope => {
    const onFormChange = vi.fn();
    const widget: WidgetState = { id: 74, threadId: 226, messageId: 74, toolName: 'analytics_query',
      widgetType: 'analytics_query', status: 'active', agentType: 'performance_marketing', createdAt: '', updatedAt: '',
      formValues: { query_type: 'campaign', question: 'Compare results', scope } };
    const view = render(<AnalyticsQueryWidget widget={widget} onFormChange={onFormChange} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(view.getByLabelText('Campaign scope')).toHaveValue(scope);
    expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ scope }));
    fireEvent.change(view.getByLabelText('Campaign scope'), { target: { value: 'all_owned' } });
    expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'all_owned' }));
  });
});
