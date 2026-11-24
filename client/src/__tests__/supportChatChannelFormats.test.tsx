import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerChat from '@/app/dashboard/(main)/support-ai/chat/page';
import { formatMessageForChannel } from '../../../server/utils/messageFormatter';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-outreach-assistants', () => ({
  useAssistantWorkspace: () => ({ profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } }, profiles: { isLoading: false, refetch: vi.fn() }, catalog: { data: { runtimeEnabled: true } } }),
  useAssistantList: () => ({ data: { runtimeEnabled: true, assistants: [{ id: 'test-assistant', draft: { name: 'Test assistant' }, draftVersion: 1 }] }, isError: false, isFetching: false, refetch: vi.fn() }),
}));

const draft = '**Stay timings**\n\n1. **Check-in:** 2:00 PM\n2. **Check-out:** 11:00 AM\n\n**Options**\n- Leisure stay\n- Corporate offsite\n- Wedding enquiry';
const channels = ['web', 'whatsapp', 'instagram', 'facebook', 'email'] as const;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: [], total: 0 });
  Element.prototype.scrollIntoView = vi.fn();
  mocks.post.mockImplementation(async (_url: string, body: { message: string; channel: string }) => {
    const content = body.channel === 'web' ? draft : formatMessageForChannel(draft, body.channel);
    return { sessionId: 9001,
      userMessage: { id: 1, sessionId: 9001, role: 'user', content: body.message, createdAt: new Date().toISOString(), metadata: { channel: body.channel } },
      assistantMessage: { id: 2, sessionId: 9001, role: 'assistant', content, createdAt: new Date().toISOString(), metadata: { channel: body.channel }, confidence: 0.99 },
      response: { answer: draft, sources: [{ title: 'Approved timings', excerpt: 'Check-in 2 PM; check-out 11 AM.', similarity: 0.99 }] },
    };
  });
});

describe('support assistant response-channel rendering', () => {
  it('keeps outer chat panels non-scrollable and restores composer focus without moving ancestors', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<OwnerChat />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'test-assistant' } });
    const viewport = screen.getByRole('region', { name: 'Support messages' });
    expect(viewport.parentElement).toHaveClass('overflow-clip');
    expect(viewport.parentElement?.parentElement).toHaveClass('overflow-clip');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Timings?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Stay timings', { exact: false });
    await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    focus.mockRestore();
  });
  it.each(channels)('submits and renders the %s format with readable choices', async channel => {
    const { container } = render(<OwnerChat />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'test-assistant' } });
    const selector = screen.getByRole('combobox', { name: 'Response channel' });
    expect(within(selector).getAllByRole('option').map(option => option.textContent)).toEqual(['Web chat', 'WhatsApp', 'Instagram', 'Facebook', 'Email']);
    fireEvent.change(selector, { target: { value: channel } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: `QA ${channel} formatting test` } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/support/ai/chat', expect.objectContaining({ channel }), { headers: { 'X-Business-Profile-Id': '1' } }));
    await screen.findByText('Stay timings', { exact: false });
    expect(container.textContent).toContain('2:00 PM');
    expect(container.textContent).toContain('11:00 AM');
    expect(container.textContent).toContain('Leisure stay');
    expect(container.textContent).toContain('Corporate offsite');
    expect(container.textContent).toContain('Wedding enquiry');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('<br');
    expect(container.textContent).not.toContain('|||');
    if (channel === 'web') {
      expect(container.querySelector('ol')?.children).toHaveLength(2);
      expect(container.querySelector('ul')?.children).toHaveLength(3);
      expect(container.querySelector('strong')).toHaveTextContent('Stay timings');
    } else if (channel === 'whatsapp' || channel === 'email') {
      expect(container.querySelector('strong')).toHaveTextContent('Stay timings');
      expect(container.querySelectorAll('br').length).toBeGreaterThanOrEqual(6);
    } else {
      expect(container.querySelector('strong')).toBeNull();
      expect(screen.getByText(/Stay timings/).textContent).toContain('\n1. Check-in: 2:00 PM\n2. Check-out: 11:00 AM');
    }
    // Selecting a different target must not reformat an already-saved answer.
    fireEvent.change(selector, { target: { value: channel === 'web' ? 'email' : 'web' } });
    expect(container.querySelector('strong') !== null).toBe(!['instagram', 'facebook'].includes(channel));
  });
});
