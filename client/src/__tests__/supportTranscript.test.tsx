import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportConversationTranscript } from '@/components/support/SupportConversationTranscript';
import { formatSupportTranscript } from '@/lib/support-transcript';
import { validateSupportChatFiles } from '@/lib/support-chat-uploads';
import { supportWidgetHeaders } from '../../config/support-widget-headers';

const mocks = vi.hoisted(() => ({ put: vi.fn(), writeText: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { put: mocks.put } }));
const message = { id: 22, role: 'assistant', content: '**Policy**\n\n- Return within 30 days', createdAt: '2026-10-03T06:00:00Z', sources: [{ title: 'Return policy', excerpt: '30 days', similarity: 0.85 }], metadata: { channel: 'web' } };
beforeEach(() => { vi.clearAllMocks(); mocks.put.mockResolvedValue({}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.writeText.mockResolvedValue(undefined) } }); Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true }); });
describe('shared support transcript', () => {
  it('labels an unconfirmed reply in the transcript and export without offering answer feedback', () => {
    const unconfirmed = { ...message, processingStatus: 'reconciliation_required' };
    render(<SupportConversationTranscript messages={[unconfirmed]} />);
    expect(screen.getByText('Delivery not confirmed · review required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Helpful' })).not.toBeInTheDocument();
    expect(formatSupportTranscript([unconfirmed])).toContain('Delivery not confirmed · review required');
  });
  it('renders markdown, sources and persisted helpful feedback', async () => {
    render(<SupportConversationTranscript messages={[message]} />);
    expect(screen.getByText('Policy').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: /1 knowledge source/ }));
    expect(screen.getByText('Return policy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    await screen.findByRole('button', { name: 'Marked helpful' });
    expect(mocks.put).toHaveBeenCalledWith('/api/support/ai/messages/22/feedback', { rating: 'helpful', status: 'reviewed' });
  });
  it('saves an actionable answer flag with a reason and notes', async () => {
    render(<SupportConversationTranscript messages={[message]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flag answer' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Feedback reason' }), { target: { value: 'outdated' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Feedback notes' }), { target: { value: 'The published policy now says 14 days.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save flag' }));
    await screen.findByRole('button', { name: 'Flagged for review' });
    expect(mocks.put).toHaveBeenCalledWith('/api/support/ai/messages/22/feedback', { rating: 'needs_review', status: 'open', reason: 'outdated', notes: 'The published policy now says 14 days.' });
  });
  it('keeps an unsaved flag recoverable after an API failure', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Could not save. Try again.'));
    render(<SupportConversationTranscript messages={[message]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Flag answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save flag' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save. Try again.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save flag' })).toBeEnabled();
  });
  it('copies the saved channel content, and exports inert text', async () => {
    render(<SupportConversationTranscript messages={[message]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(message.content));
    const result = formatSupportTranscript([{ ...message, content: '<script>secret()</script>' }], 'A / chat');
    expect(result).toContain('Assistant · 2026-10-03T06:00:00.000Z');
    expect(result).toContain('<script>secret()</script>');
  });
  it('does not treat WhatsApp user-supplied HTML as markup', () => {
    const { container } = render(<SupportConversationTranscript feedbackEnabled={false} messages={[{ ...message, content: '*Policy* <img src=x onerror=alert(1)>', metadata: { channel: 'whatsapp' } }]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Policy').tagName).toBe('STRONG');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('links recorded sources to the existing knowledge entry', () => {
    render(<SupportConversationTranscript messages={[{ ...message, sources: [{ sourceId: 55, title: 'Current policy' }] }]} />);
    fireEvent.click(screen.getByRole('button', { name: /1 knowledge source/ }));
    expect(screen.getByRole('link', { name: 'Current policy' })).toHaveAttribute('href', '/dashboard/knowledge-base/55');
  });
});

describe('support upload boundaries', () => {
  it('rejects count, per-file, combined and unsupported type limits before upload', () => {
    const file = { name: 'policy.pdf', size: 1024 };
    expect(validateSupportChatFiles(Array(6).fill(file))).toMatch(/five files/);
    expect(validateSupportChatFiles([{ ...file, size: 11 * 1024 * 1024 }])).toMatch(/10 MB/);
    expect(validateSupportChatFiles([{ ...file, size: 10 * 1024 * 1024 }], [{ size: 11 * 1024 * 1024 }])).toMatch(/20 MB/);
    expect(validateSupportChatFiles([{ name: 'unreadable.zip', size: 1024 }])).toMatch(/use a PDF/);
    expect(validateSupportChatFiles([{ ...file, size: 0 }])).toMatch(/empty/);
    expect(validateSupportChatFiles([file])).toBeNull();
  });
});

it('makes only the widget frameable while retaining all other security directives', () => {
  const headers = [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }, { key: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'self'; object-src 'none'" }, { key: 'X-Content-Type-Options', value: 'nosniff' }];
  const widget = supportWidgetHeaders(headers);
  expect(widget.find(h => h.key === 'X-Frame-Options')).toBeUndefined();
  expect(widget.find(h => h.key === 'Content-Security-Policy')?.value).toBe("default-src 'self'; frame-ancestors http: https:; object-src 'none'");
  expect(widget).toContainEqual(headers[2]);
  expect(headers[1].value).toContain("frame-ancestors 'self'");
});
