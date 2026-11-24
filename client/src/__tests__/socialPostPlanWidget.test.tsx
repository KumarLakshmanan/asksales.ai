import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SocialPostWidget } from '@/components/widgets/SocialPostWidget';
import { InlineWidgetCard } from '@/components/widgets/InlineWidgetCard';
import type { WidgetState } from '@/components/widgets/types';

vi.mock('@/components/widgets/WidgetContext', () => ({ useWidgets: () => ({ submitWidget: vi.fn(), updateFormValues: vi.fn(), closeWidget: vi.fn() }) }));

const widget = (extra: Partial<WidgetState> = {}) => ({
  id: 7, threadId: 1, messageId: 1, toolName: 'generate_social_media_post', widgetType: 'social_post', status: 'active',
  formValues: { platform: 'instagram', topic: 'Launch month', number_of_posts: 30 }, agentType: 'content_studio', createdAt: '', updatedAt: '', ...extra,
}) as WidgetState;

describe('multi-post content plan review', () => {
  it('shows the reviewed post count and sends changes with the form', async () => {
    const onFormChange = vi.fn();
    render(<SocialPostWidget widget={widget()} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    const count = screen.getByLabelText('Number of posts') as HTMLInputElement;
    expect(count.value).toBe('30');
    expect(screen.getByText(/Creates 30 separate draft posts, each checked against the platform's character limit/)).toBeInTheDocument();
    fireEvent.change(count, { target: { value: '99' } });
    await waitFor(() => expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ number_of_posts: 30 })));
    fireEvent.change(count, { target: { value: '7' } });
    await waitFor(() => expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ number_of_posts: 7 })));
  });

  it('defaults to one post with a hint about plans', () => {
    render(<SocialPostWidget widget={widget({ formValues: { platform: 'instagram', topic: 'Launch' } })} onFormChange={vi.fn()} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect((screen.getByLabelText('Number of posts') as HTMLInputElement).value).toBe('1');
    expect(screen.getByText(/e\.g\. 30 for a 30-day plan/)).toBeInTheDocument();
  });

  it('shows live progress while the plan is being written', async () => {
    render(<InlineWidgetCard widget={widget({ status: 'running', progress: { completed: 12, total: 30, message: 'Wrote 12 of 30 posts…' } })} />);
    fireEvent.click(screen.getByRole('button', { name: /Running/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Wrote 12 of 30 posts… (12/30)'));
  });
});
