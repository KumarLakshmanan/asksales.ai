import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdGenerationWidget } from '@/components/widgets/AdGenerationWidget';
import type { WidgetState } from '@/components/widgets/types';

describe('ad generation reviewed constraints', () => {
  it('preserves exact CTA, constraints, destination and disabled prompt flags on edit', async () => {
    const onFormChange = vi.fn();
    const widget = { id: 53, formValues: { platform: 'meta', ad_format: 'text', cta_text: 'Ask for a workflow review.', content_instructions: 'No emoji or performance claims.', landing_url: 'https://example.invalid', include_image_prompt: false, include_video_prompt: false } } as unknown as WidgetState;
    render(<AdGenerationWidget widget={widget} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Content constraints' }), { target: { value: 'Calm English. No emoji or performance claims.' } });
    await waitFor(() => expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ cta_text: 'Ask for a workflow review.', content_instructions: 'Calm English. No emoji or performance claims.', landing_url: 'https://example.invalid', include_image_prompt: false, include_video_prompt: false, auto_generate_image: false, auto_generate_video: false })));
  });
  it('omits an empty optional URL instead of submitting an invalid empty URL', async () => {
    const onFormChange = vi.fn();
    render(<AdGenerationWidget widget={{ id: 54, formValues: {} } as unknown as WidgetState} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await waitFor(() => expect(onFormChange).toHaveBeenCalled());
    expect(onFormChange.mock.lastCall?.[0]).not.toHaveProperty('landing_url');
  });
});
