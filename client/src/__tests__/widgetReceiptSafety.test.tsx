import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineWidgetCard } from '@/components/widgets/InlineWidgetCard';
import type { WidgetState } from '@/components/widgets/types';

vi.mock('@/components/widgets/WidgetContext', () => ({ useWidgets: () => ({ submitWidget: vi.fn(), updateFormValues: vi.fn(), closeWidget: vi.fn() }) }));
vi.mock('@/components/widgets/registry', () => ({ widgetRegistry: {
  analytics_query: { title: 'Analytics', description: 'Review', component: () => <label>Question<input defaultValue="Synthetic overview" /></label> },
} }));

describe('widget receipts override optimistic retry hints', () => {
  it.each([
    { retrySafe: true, ambiguous: true },
    { retrySafe: true, output: { queuedCount: 1 } },
    { retrySafe: true, results: [{ success: true }] },
    { retrySafe: true, output: { status: 'partial_success' } },
  ])('keeps unsafe failed work read-only: %j', executionResult => {
    const widget = { id: 1, widgetType: 'analytics_query', toolName: 'analytics_query', status: 'failed',
      formValues: {}, executionResult, executionAttemptCount: 1 } as WidgetState;
    render(<InlineWidgetCard widget={widget} />);
    expect(screen.queryByRole('button', { name: /Retry safely|Confirm and run|Save draft/ })).not.toBeInTheDocument();
    expect(screen.queryByText('This attempt failed before any side effect and may be retried safely.')).not.toBeInTheDocument();
  });
  it('does not describe an uncertain legacy cancelled receipt as cancelled before execution', () => {
    const widget = { id: 1, widgetType: 'analytics_query', toolName: 'analytics_query', status: 'cancelled',
      formValues: {}, executionResult: { ambiguous: true }, executionAttemptCount: 1 } as WidgetState;
    render(<InlineWidgetCard widget={widget} />);
    fireEvent.click(screen.getByRole('button', { name: /Cancelled/ }));
    expect(screen.queryByText('Cancelled before execution. This review is read-only and cannot run.')).not.toBeInTheDocument();
    expect(screen.getByText(/requires reconciliation/i)).toBeVisible();
  });
});
