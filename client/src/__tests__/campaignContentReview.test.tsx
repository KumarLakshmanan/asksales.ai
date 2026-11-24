import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmsTemplateWidget } from '@/components/widgets/SmsTemplateWidget';
import { BlogPostWidget } from '@/components/widgets/BlogPostWidget';
import { SocialChatTemplateWidget } from '@/components/widgets/SocialChatTemplateWidget';
import { WhatsappTemplateWidget } from '@/components/widgets/WhatsappTemplateWidget';
import WhatsappTab from '@/components/tabs/content-studio/WhatsappTab';
import { VideoGenerationWidget } from '@/components/widgets/VideoGenerationWidget';
import type { WidgetState } from '@/components/widgets/types';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const widget = (formValues: Record<string, unknown>) => ({ id: 141, formValues }) as unknown as WidgetState;

describe('campaign content review', () => {
  it('retains an edited exact blog CTA and content requirements in the submitted form', () => {
    const changed = vi.fn();
    render(<BlogPostWidget widget={widget({ topic: 'NimbusFlow', cta_text: 'Book a demo.' })} onFormChange={changed} onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Exact CTA text' }), { target: { value: 'Book a demo—no pressure.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Content instructions' }), { target: { value: 'Fictional NimbusFlow; no workspace identity.' } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ cta_text: 'Book a demo—no pressure.', content_instructions: 'Fictional NimbusFlow; no workspace identity.', auto_generate_image: false, auto_generate_video: false }));
  });
  it.each([SmsTemplateWidget, SocialChatTemplateWidget])('requires an explicit opt-in for companion images', async Component => {
    const changed = vi.fn();
    render(<Component widget={widget({})} onFormChange={changed} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ auto_generate_image: false, include_image_prompt: false })));
    fireEvent.click(screen.getByRole('switch', { name: /Generate accompanying image/ }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ auto_generate_image: true, include_image_prompt: true }));
  });

  it('shows the saved WhatsApp body and refreshes the current campaign library', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ id: 280, title: 'nimbusflow_intro', content: JSON.stringify({ header: 'Meet NimbusFlow', body: 'A fictional workflow for small sales teams.', footer: 'Reply STOP to opt out.' }) }] as never);
    const view = render(<WhatsappTab threadId={214} />);
    await screen.findByText('No WhatsApp Templates Yet');
    view.rerender(<WhatsappTab threadId={214} refreshKey={1} />);
    expect(await screen.findByText(/A fictional workflow/)).toHaveTextContent('Reply STOP to opt out.');
    expect(api.get).toHaveBeenLastCalledWith('/api/content/assets?type=whatsapp_template&threadId=214');
  });

  it('preserves edited WhatsApp message and buttons in its review', () => {
    const changed = vi.fn();
    render(<WhatsappTemplateWidget widget={widget({ template_name: 'nimbusflow_intro', body_text: 'Meet NimbusFlow.', quick_reply_buttons: ['Learn more'] })} onFormChange={changed} onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'A fictional campaign message.' } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ body_text: 'A fictional campaign message.', quick_reply_buttons: ['Learn more'] }));
  });

  it('renders supported video defaults for a legacy invalid review', () => {
    const changed = vi.fn();
    render(<VideoGenerationWidget widget={widget({ prompt: 'QA visual', provider: 'google', resolution: '480p', duration_seconds: 5 })} onFormChange={changed} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getAllByRole('combobox').map(element => element.textContent)).toContain('720p');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: '720p', duration_seconds: 8, number_of_videos: 1 }));
  });
});
