import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageBubble from '@/components/MessageBubble';
import { WidgetProvider } from '@/components/widgets';
import { selectBusinessProfile } from '@/lib/business-profile';

const fetchMock = vi.fn<typeof fetch>();
let click: ReturnType<typeof vi.spyOn>;
const message = { id: 'private-file', role: 'user' as const, timestamp: Date.now(), content: 'Synthetic private attachment',
  metadata: { attachments: [{ fileId: 73, name: 'beta.txt', size: 12, mimeType: 'text/plain' }] } };
const ticket = () => new Response(JSON.stringify({ success: true, data: { url: '/api/settings/storage/download-ticket?ticket=synthetic-one-use' } }), { status: 200, headers: { 'content-type': 'application/json' } });
function bubble() { return render(<WidgetProvider><MessageBubble message={message} /></WidgetProvider>); }
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('token', 'synthetic-auth-only');
  localStorage.setItem('user', JSON.stringify({ id: 7 }));
  sessionStorage.setItem('active-business-profile:7', '202');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('MessageBubble private attachment tickets', () => {
  it('uses the selected business on authenticated ticket issuance and only navigates to the resulting capability', async () => {
    fetchMock.mockResolvedValue(ticket());
    bubble();
    const button = screen.getByRole('button', { name: 'Download beta.txt' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings/storage/workspace/download');
    const headers = new Headers(options?.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-auth-only');
    expect(headers.get('x-business-profile-id')).toBe('202');
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ fileIds: [73] }) });
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe('/api/settings/storage/download-ticket?ticket=synthetic-one-use');
    expect(anchor.referrerPolicy).toBe('no-referrer');
    expect(anchor.href).not.toContain('synthetic-auth-only');
    expect(button).toHaveFocus();
    expect(button).toBeEnabled();
  });
  it('announces a refusal and permits an explicit retry, without navigating to a private raw URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'File not found' }), { status: 404 }));
    bubble();
    fireEvent.click(screen.getByRole('button', { name: 'Download beta.txt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This attachment could not be downloaded. Try again.');
    expect(click).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(ticket());
    fireEvent.click(screen.getByRole('button', { name: 'Download beta.txt' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('suppresses overlapping issuance and aborts a pending request when the message disappears', async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const view = bubble();
    const button = screen.getByRole('button', { name: 'Download beta.txt' });
    fireEvent.click(button); fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { complete(ticket()); });
    expect(click).not.toHaveBeenCalled();
  });
  it('does not open an old business capability after changing the selected business', async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    bubble(); fireEvent.click(screen.getByRole('button', { name: 'Download beta.txt' }));
    act(() => selectBusinessProfile(303));
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => { complete(ticket()); });
    expect(click).not.toHaveBeenCalled();
  });
});
