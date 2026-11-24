import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SocialPostWidget } from '@/components/widgets/SocialPostWidget';
import { BlogPostWidget } from '@/components/widgets/BlogPostWidget';
import { EmailTemplateWidget } from '@/components/widgets/EmailTemplateWidget';
import type { WidgetState } from '@/components/widgets/types';

describe('content generation media exclusions survive review edits', () => {
  it.each([
    ['social post', SocialPostWidget],
    ['blog post', BlogPostWidget],
    ['email', EmailTemplateWidget],
  ])('preserves explicit false prompt flags for %s', async (_name, Component) => {
    const onFormChange = vi.fn();
    const widget = { id: 751, formValues: { topic: 'Reviewed topic', include_image_prompt: false, include_video_prompt: false } } as unknown as WidgetState;
    render(<Component widget={widget} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Updated reviewed brief' } });
    await waitFor(() => expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ include_image_prompt: false, include_video_prompt: false, auto_generate_image: false, auto_generate_video: false })));
  });
});
