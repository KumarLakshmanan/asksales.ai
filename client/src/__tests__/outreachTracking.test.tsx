import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingHome } from '@/components/outreach/tracking/TrackingHome';
import { OutreachDetailPage } from '@/components/outreach/tracking/OutreachDetailPage';
import { DateRangeField, addDays, dateRangeLength, presetDateRange, toDateValue } from '@/components/ui/date-range-field';
import { downloadRecipients } from '@/components/outreach/tracking/RecipientDownload';
import { viewerTimezone } from '@/components/outreach/tracking/DayByDayCard';
import { emptyBatchCounts, type BatchCounts, type DailyActivity, type OutreachBatchList, type OutreachBatchSummary, type OutreachRecipient, type TemplatePerformanceReport, type UpcomingSchedule } from '../../../shared/outreachTracking';

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error { constructor(message: string, public status?: number) { super(message); } }
  return { api: { get: mocks.get, patch: mocks.patch }, ApiError, buildApiUrl: (path: string) => `http://api.test${path}` };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/authHeaders', () => ({ getAuthHeaders: () => ({ Authorization: 'Bearer t', 'x-business-profile-id': '11' }) }));
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no scrollIntoView; an opened select scrolls its chosen option into view.
  if (!Element.prototype.scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
const { ApiError } = await import('@/lib/api');

const ID = '0b0f3c1e-8a55-4a57-9d0f-2f1f0c4f6a10';
const counts = (values: Partial<BatchCounts>): BatchCounts => ({ ...emptyBatchCounts(), ...values });
const batch = {
  id: ID, name: 'Diwali offer', channel: 'whatsapp', providerAccountId: 'phone-1', templateName: 'diwali_sale', templateLanguage: 'en',
  source: 'new_outreach', admission: 'queued', createdAt: '2026-11-10T08:00:00Z', scheduledAt: null, expiresAt: '2026-12-10T08:00:00Z',
  requested: 402, skipped: 2, receiptSupport: 'full',
} as const;
const sending = counts({ total: 400, sent: 40, delivered: 200, read: 60, waitingLimit: 90, failed: 8, expired: 2 });
const list = (items: OutreachBatchList['items']): OutreachBatchList => ({ items, page: 1, pageSize: 20, total: items.length });
const summary = (): OutreachBatchSummary => ({
  batch, counts: sending, followUps: emptyBatchCounts(), skippedReasons: [{ reason: 'Lead has opted out or is blocked from outreach', count: 2 }],
  nextAttemptAt: '2026-11-11T00:00:01Z', lastActivityAt: '2026-11-11T08:00:00Z', checkedAt: '2026-11-10T09:00:00Z',
});
const recipient = (id: number, values: Partial<OutreachRecipient> = {}): OutreachRecipient => ({
  messageId: id, conversationId: id + 100, leadId: id + 200, name: `Guest ${id}`, recipient: `91980000000${id}`, state: 'delivered',
  sentAt: '2026-11-10T08:05:00Z', deliveredAt: '2026-11-10T08:06:00Z', readAt: null, failedAt: null, nextAttemptAt: null, reason: null, providerCode: null,
  ...values,
});

const daily = (): DailyActivity => ({
  timezone: 'UTC', from: '2026-11-10', to: '2026-11-11',
  days: [{ date: '2026-11-10', sent: 250, delivered: 200, read: 40, failed: 6 }, { date: '2026-11-11', sent: 50, delivered: 60, read: 20, failed: 4 }],
  totals: { sent: 300, delivered: 260, read: 60, failed: 10 },
});
const upcoming = (): UpcomingSchedule => ({
  timezone: 'UTC', from: '2026-11-14', until: '2026-12-14', waiting: 2600, afterRange: 0, limitResetsAt: '2026-11-15T00:00:01Z',
  limits: [{ channel: 'whatsapp', dailyLimit: 1000, usedToday: 0 }],
  days: [
    { date: '2026-11-14', due: 0, expectedToSend: 0, held: 0, willExpire: 0, outreaches: [] },
    { date: '2026-11-15', due: 2600, expectedToSend: 1000, held: 1600, willExpire: 0, outreaches: [{ batchId: ID, name: 'Diwali offer', due: 2600 }] },
    { date: '2026-11-16', due: 0, expectedToSend: 1000, held: 0, willExpire: 600, outreaches: [] },
  ],
});
const templates = (): TemplatePerformanceReport => ({
  timezone: 'UTC', from: '2026-10-16', to: '2026-11-14',
  templates: [{ templateName: 'diwali_sale', templateLanguage: 'en', outreaches: 2, sent: 900, delivered: 810, read: 300, failed: 12, lastSentAt: '2026-11-12T10:00:00Z' }],
});
beforeEach(() => { vi.resetAllMocks(); window.history.replaceState(null, '', '/dashboard/outreach/tracking'); });
afterEach(cleanup);

describe('Message tracking list', () => {
  it('shows each outreach with how far it has got and links to its page', async () => {
    mocks.get.mockResolvedValue(list([{ ...batch, counts: sending }]));
    render(<TrackingHome />);

    const link = await screen.findByRole('link', { name: 'Diwali offer' });
    expect(link).toHaveAttribute('href', `/dashboard/outreach/tracking/${ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('WhatsApp · diwali_sale')).toBeInTheDocument();
    expect(within(row).getAllByText('300 of 400 sent').length).toBeGreaterThan(0);
    // Every unsent message is held by a sending limit, so nothing is going out right now.
    expect(within(row).getByText('Waiting for sending limit')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/api/outreach/batches', { params: { state: 'all', page: 1, pageSize: 20 } });
  });

  it('says Sending only while some messages are actually going out', async () => {
    mocks.get.mockResolvedValue(list([{ ...batch, counts: counts({ total: 400, sent: 40, delivered: 200, read: 60, waitingLimit: 80, sending: 10, failed: 8, expired: 2 }) }]));
    render(<TrackingHome />);
    const row = (await screen.findByRole('link', { name: 'Diwali offer' })).closest('tr')!;
    expect(within(row).getByText('Sending')).toBeInTheDocument();
  });

  it('explains an empty list and offers the next step', async () => {
    mocks.get.mockResolvedValue(list([]));
    render(<TrackingHome />);
    expect(await screen.findByText('No outreach yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start an outreach' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/outreach/create');
  });

  it('searches by name and says so when nothing matches', async () => {
    mocks.get.mockResolvedValue(list([]));
    render(<TrackingHome />);
    await screen.findByText('No outreach yet');
    const search = screen.getByRole('searchbox', { name: 'Search outreach names' });
    fireEvent.change(search, { target: { value: 'holi' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/outreach/batches', { params: { q: 'holi', state: 'all', page: 1, pageSize: 20 } }));
    expect(await screen.findByText('No outreach matches these filters')).toBeInTheDocument();
  });

  it('lets the person retry when the list cannot be loaded', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(list([{ ...batch, counts: sending }]));
    render(<TrackingHome />);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load your outreaches.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Diwali offer' })).toBeInTheDocument();
  });
});

describe('Outreach tracking detail', () => {
  const serve = (pages: Record<string, { items: OutreachRecipient[]; nextCursor: number | null }> = {}) =>
    mocks.get.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
      if (url.endsWith('/daily')) return daily();
      if (url.endsWith('/upcoming')) return upcoming();
      if (url.endsWith('/failures')) return [{ reason: 'Message undeliverable', providerCode: '131026', count: 8 }];
      if (url.endsWith('/messages')) return pages[`${options?.params?.status}:${options?.params?.cursor ?? ''}`] ?? { items: [recipient(1)], nextCursor: null };
      return summary();
    });

  it('summarises delivery in plain words and warns about the daily limit and expiry', async () => {
    serve();
    render(<OutreachDetailPage id={ID} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Diwali offer' })).toBeInTheDocument();
    const tiles = screen.getByRole('group', { name: 'Delivery summary' });
    for (const [label, value] of [['Recipients', '400'], ['Sent', '300'], ['Delivered', '260'], ['Read', '60'], ['Failed', '10'], ['Still waiting', '90']])
      expect(within(within(tiles).getByText(label).closest('article')!).getByText(value)).toBeInTheDocument();
    expect(within(tiles).getByText('Includes 2 expired')).toBeInTheDocument();
    expect(within(tiles).getByText('2 skipped before sending')).toBeInTheDocument();
    expect(screen.getByText('90 messages are waiting for a sending limit')).toBeInTheDocument();
    expect(screen.getByText(/Anything not sent by .* will expire\./)).toBeInTheDocument();
    expect(screen.getByText('Lead has opted out or is blocked from outreach')).toBeInTheDocument();
    expect(await screen.findByText(/It may not be on WhatsApp/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All outreaches/ })).toHaveAttribute('href', '/dashboard/outreach/tracking');
  });

  it('jumps from the failure reasons to the failed recipients', async () => {
    serve({
      'all:': { items: [recipient(1)], nextCursor: null },
      'failed:': { items: [recipient(7, { state: 'failed', reason: 'Message undeliverable', providerCode: '131026', deliveredAt: null, failedAt: '2026-11-10T08:07:00Z' })], nextCursor: null },
    });
    render(<OutreachDetailPage id={ID} />);
    expect(await screen.findByText('Guest 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show these recipients' }));
    expect(await screen.findByText('Guest 7')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Failed/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'Open conversation with Guest 7' })).toHaveAttribute('href', '/dashboard/outreach/inbox?thread=conversation:107');
    expect(mocks.get).toHaveBeenCalledWith(`/api/outreach/batches/${ID}/messages`, { params: { status: 'failed', kind: 'outreach', limit: 50 } });
  });

  it('pages a search forward and back without knowing the total', async () => {
    serve({
      'all:': { items: [recipient(1)], nextCursor: 1 },
      'all:1': { items: [recipient(2)], nextCursor: null },
    });
    render(<OutreachDetailPage id={ID} />);
    await screen.findByText('Guest 1');
    const search = screen.getByRole('searchbox', { name: 'Search by name or phone number' });
    fireEvent.change(search, { target: { value: 'guest' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/api/outreach/batches/${ID}/messages`, { params: { status: 'all', kind: 'outreach', q: 'guest', limit: 50 } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Guest 2')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith(`/api/outreach/batches/${ID}/messages`, { params: { status: 'all', kind: 'outreach', q: 'guest', cursor: 1, limit: 50 } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Guest 1')).toBeInTheDocument();
  });

  it('asks for day-by-day numbers by the dates things happened, in the viewer timezone, and offers them as a table', async () => {
    serve();
    render(<OutreachDetailPage id={ID} />);
    await screen.findByRole('heading', { level: 1, name: 'Diwali offer' });
    const today = toDateValue(new Date());
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/api/outreach/batches/${ID}/daily`, {
      params: { from: addDays(today, -29) > '2026-11-10' ? addDays(today, -29) : '2026-11-10', to: today, tz: viewerTimezone() },
    }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Show as table' }))[0]);
    const table = screen.getByRole('table', { name: /Messages per day for Diwali offer/ });
    const total = within(table).getByText('Total').closest('tr')!;
    expect(within(total).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Total', '300', '260', '60', '10']);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('renames the outreach and reloads its details', async () => {
    serve();
    mocks.patch.mockResolvedValue({});
    render(<OutreachDetailPage id={ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename this outreach' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Festive offer ' } });
    const before = mocks.get.mock.calls.filter(([url]) => url === `/api/outreach/batches/${ID}`).length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(`/api/outreach/batches/${ID}`, { name: 'Festive offer' }));
    await waitFor(() => expect(mocks.get.mock.calls.filter(([url]) => url === `/api/outreach/batches/${ID}`).length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows follow-ups apart from the first message and lists their recipients', async () => {
    const followUps = counts({ total: 50, sent: 20, delivered: 10, cancelled: 3, scheduled: 17 });
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/daily') ? daily() : url.endsWith('/upcoming') ? upcoming()
      : url.endsWith('/failures') ? [] : url.endsWith('/messages') ? { items: [recipient(1)], nextCursor: null }
      : { ...summary(), followUps });
    render(<OutreachDetailPage id={ID} />);
    const card = (await screen.findByText('Follow-ups', { selector: '[data-slot="card-title"], h3, div' })).closest('[data-slot="card"], div.rounded-xl, section') ?? document.body;
    expect(within(card as HTMLElement).getByRole('group', { name: 'Follow-up summary' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show follow-up recipients' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/api/outreach/batches/${ID}/messages`, { params: { status: 'all', kind: 'follow_up', limit: 50 } }));
    expect(screen.getByRole('tab', { name: /Follow-ups/ })).toHaveAttribute('aria-selected', 'true');
    // Something was cancelled among the follow-ups, so that filter appears.
    expect(screen.getByRole('tab', { name: /Cancelled/ })).toHaveTextContent('3');
  });

  it('names the address to search by after the channel', async () => {
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/daily') ? daily() : url.endsWith('/upcoming') ? upcoming()
      : url.endsWith('/failures') ? [] : url.endsWith('/messages') ? { items: [], nextCursor: null }
      : { ...summary(), batch: { ...batch, channel: 'email' } });
    render(<OutreachDetailPage id={ID} />);
    expect(await screen.findByRole('searchbox', { name: 'Search by name or email address' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Cancelled/ })).not.toBeInTheDocument();
  });

  it('says so when the outreach belongs to another business', async () => {
    mocks.get.mockRejectedValue(new ApiError('This outreach is not available in this business.', 404));
    render(<OutreachDetailPage id={ID} />);
    expect(await screen.findByText("This outreach isn't available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Message tracking' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/outreach/tracking');
  });

  it('offers a retry when the outreach cannot be loaded', async () => {
    mocks.get.mockRejectedValue(new Error('offline'));
    render(<OutreachDetailPage id={ID} />);
    expect(await screen.findByText("We couldn't load this outreach")).toBeInTheDocument();
  });
});

describe('Message tracking by day', () => {
  it('opens the By day view from the address and loads the last 7 days for every outreach', async () => {
    window.history.replaceState(null, '', '/dashboard/outreach/tracking?view=days');
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/daily') ? daily() : list([]));
    render(<TrackingHome />);
    expect(await screen.findByRole('tab', { name: 'By day' })).toHaveAttribute('aria-selected', 'true');
    const today = toDateValue(new Date());
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/outreach/daily', {
      params: { from: addDays(today, -6), to: today, tz: viewerTimezone() },
    }));
    expect(await screen.findByText(/counted on the day it happened/)).toBeInTheDocument();
  });

  it('shows follow-ups or every outbound message when asked, starting with initial outreach', async () => {
    window.history.replaceState(null, '', '/dashboard/outreach/tracking?view=days');
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/daily') ? daily() : list([]));
    render(<TrackingHome />);
    const kind = await screen.findByRole('combobox', { name: 'Outbound messages' });
    expect(kind).toHaveTextContent('Initial outreach');
    const dailyCalls = () => mocks.get.mock.calls.filter(([url]) => url === '/api/outreach/daily');
    await waitFor(() => expect(dailyCalls().length).toBeGreaterThan(0));
    // Initial outreach is the API's default, so the first request does not name a kind.
    expect(dailyCalls()[0][1].params.kind).toBeUndefined();

    fireEvent.keyDown(kind, { key: 'ArrowDown' });
    for (const label of ['Initial outreach', 'Follow-ups', 'Outreach and follow-ups']) {
      expect(await screen.findByRole('option', { name: label })).toBeVisible();
    }
    fireEvent.click(screen.getByRole('option', { name: 'Follow-ups' }));
    await waitFor(() => expect(dailyCalls().at(-1)![1].params).toMatchObject({ kind: 'follow_up' }));
    expect(screen.getByRole('combobox', { name: 'Outbound messages' })).toHaveTextContent('Follow-ups');
  });
});

describe('date range field', () => {
  it('computes preset ranges with both ends included', () => {
    expect(presetDateRange('last7', '2026-11-14')).toEqual({ from: '2026-11-08', to: '2026-11-14' });
    expect(presetDateRange('thisMonth', '2026-11-14')).toEqual({ from: '2026-11-01', to: '2026-11-14' });
    expect(presetDateRange('next30', '2026-11-14')).toEqual({ from: '2026-11-14', to: '2026-12-13' });
    expect(dateRangeLength({ from: '2026-11-10', to: '2026-11-13' })).toBe(4);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('applies a custom range only when it is valid', () => {
    const onChange = vi.fn();
    render(<DateRangeField value={{ from: '2026-11-10', to: '2026-11-13' }} onChange={onChange} maxDays={93} />);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-20' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-20' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-12-01' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The end date must not be before the start date.');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose 93 days or fewer.');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('recipient download', () => {
  it('requests the CSV with sign-in and business headers and saves it under the server name', async () => {
    const response = new Response('a,b', { status: 200, headers: { 'content-disposition': 'attachment; filename="diwali-offer-recipients-2026-11-14.csv"' } });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:x'), revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('diwali-offer-recipients-2026-11-14.csv'); });

    await downloadRecipients(ID, 'failed', 'outreach-recipients');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/outreach/batches/${ID}/export.csv?status=failed&kind=outreach&tz=`);
    expect(init).toMatchObject({ credentials: 'include', headers: { Authorization: 'Bearer t', 'x-business-profile-id': '11' } });
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');

    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(downloadRecipients(ID, 'all', 'x')).rejects.toThrow('The download could not be prepared.');
    vi.unstubAllGlobals();
  });

  it('writes straight to the chosen file where the browser can save to disk', async () => {
    const written: string[] = [];
    const writable = new WritableStream<Uint8Array>({ write: chunk => { written.push(new TextDecoder().decode(chunk)); } });
    const picker = vi.fn().mockResolvedValue({ createWritable: async () => writable });
    vi.stubGlobal('showSaveFilePicker', picker);
    const fetchMock = vi.fn().mockResolvedValue(new Response('Name,Status\r\nAsha,Failed\r\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');

    await downloadRecipients(ID, 'failed', 'outreach-recipients', 'follow_up');

    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'outreach-recipients-follow-ups-failed.csv' }));
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=failed&kind=follow_up');
    expect(written.join('')).toBe('Name,Status\r\nAsha,Failed\r\n');
    expect(click).not.toHaveBeenCalled();

    // Closing the save dialog cancels quietly, without a request.
    picker.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(downloadRecipients(ID, 'all', 'x')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('Message tracking coming up and by template', () => {
  it('shows what is waiting day by day, what the limit lets through and what will expire', async () => {
    window.history.replaceState(null, '', '/dashboard/outreach/tracking?view=upcoming');
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/upcoming') ? upcoming() : list([]));
    render(<TrackingHome />);

    expect(await screen.findByText('About 600 messages will expire before they can be sent')).toBeInTheDocument();
    // The schedule opens as a chart; the table holds the same numbers.
    expect(screen.getByRole('img', { name: /Bar chart of the coming days: about 2,000 messages expected to send and 600 expected to expire/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const today = toDateValue(new Date());
    expect(mocks.get).toHaveBeenCalledWith('/api/outreach/upcoming', { params: { until: addDays(today, 30), tz: viewerTimezone() } });
    const table = screen.getByRole('table', { name: 'Messages due on each coming day' });
    // The day with nothing due is left out.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('link', { name: 'Diwali offer' })).toHaveAttribute('href', `/dashboard/outreach/tracking/${ID}`);
    expect(screen.getByText(/Your daily limit is 1,000 WhatsApp messages/)).toBeInTheDocument();
    expect(screen.getByText(/2,600/, { selector: 'span' })).toBeInTheDocument();
  });

  it('refuses a date beyond how far the schedule can look', async () => {
    window.history.replaceState(null, '', '/dashboard/outreach/tracking?view=upcoming');
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/upcoming') ? upcoming() : list([]));
    render(<TrackingHome />);
    await screen.findByRole('img', { name: /Bar chart of the coming days/ });
    const calls = mocks.get.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Show until'), { target: { value: addDays(toDateValue(new Date()), 200) } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose a date from today up to/);
    expect(mocks.get.mock.calls.length).toBe(calls);
  });

  it('goes from a template to the outreaches that used it, and back to all outreaches', async () => {
    window.history.replaceState(null, '', '/dashboard/outreach/tracking?view=templates');
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/templates/performance') ? templates() : list([{ ...batch, counts: sending }]));
    render(<TrackingHome />);

    const row = (await screen.findByRole('button', { name: 'Show outreaches that used diwali_sale' })).closest('tr')!;
    expect(within(row).getByText('90%')).toBeInTheDocument();
    expect(within(row).getByText('37%')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Show outreaches that used diwali_sale' }));

    expect(await screen.findByRole('link', { name: 'Diwali offer' })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith('/api/outreach/batches', { params: { templateName: 'diwali_sale', state: 'all', page: 1, pageSize: 20 } });
    expect(window.location.search).toBe('?template=diwali_sale');
    fireEvent.click(screen.getByRole('button', { name: 'Show all outreaches' }));
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith('/api/outreach/batches', { params: { state: 'all', page: 1, pageSize: 20 } }));
    expect(window.location.search).toBe('');
  });

  it('shows the coming-up schedule on an outreach that still has messages waiting', async () => {
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/upcoming') ? upcoming() : url.endsWith('/daily') ? daily()
      : url.endsWith('/failures') ? [] : url.endsWith('/messages') ? { items: [], nextCursor: null }
      : { batch, counts: sending, followUps: emptyBatchCounts(), skippedReasons: [], nextAttemptAt: null, lastActivityAt: null, checkedAt: '2026-11-10T09:00:00Z' });
    render(<OutreachDetailPage id={ID} />);
    expect(await screen.findByRole('img', { name: /Bar chart of the coming days/ })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show as table' }).at(-1)!);
    expect(screen.getByRole('table', { name: 'Messages due on each coming day' })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(`/api/outreach/batches/${ID}/upcoming`, expect.anything());
    expect(screen.getByText(/shared by all your outreaches on the same channel/)).toBeInTheDocument();
  });
});

describe('interactive charts', () => {
  it('lists recipients for the part of the breakdown that is pressed, and clears it on a second press', async () => {
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/daily') ? daily() : url.endsWith('/upcoming') ? upcoming()
      : url.endsWith('/failures') ? [] : url.endsWith('/messages') ? { items: [recipient(1)], nextCursor: null } : summary());
    render(<OutreachDetailPage id={ID} />);
    const bar = await screen.findByRole('group', { name: 'Messages by current status' });
    // 60 read, 200 delivered, 40 sent, 90 waiting, 10 failed; needs attention is zero so it has no part in the bar.
    expect(within(bar).getAllByRole('button')).toHaveLength(5);
    fireEvent.click(within(bar).getByRole('button', { name: /^Delivered: 200 messages, 50%/ }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/api/outreach/batches/${ID}/messages`, { params: { status: 'delivered', kind: 'outreach', limit: 50 } }));
    expect(screen.getByRole('tab', { name: /Delivered/ })).toHaveAttribute('aria-selected', 'true');
    const legend = screen.getByRole('list', { name: 'Status legend' });
    expect(within(legend).getByRole('button', { name: /Needs attention/ })).toHaveTextContent('0');
    fireEvent.click(within(legend).getByRole('button', { name: /Delivered/ }));
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('hides and shows a line from the legend but always keeps one', async () => {
    window.history.replaceState(null, '', '/dashboard/outreach/tracking?view=days');
    mocks.get.mockImplementation(async (url: string) => url.endsWith('/daily') ? daily() : list([]));
    render(<TrackingHome />);
    const sent = await screen.findByRole('button', { name: /^Sent: 300\. Shown on the chart\./ });
    fireEvent.click(sent);
    expect(screen.getByRole('button', { name: /^Sent: 300\. Hidden on the chart\./ })).toHaveAttribute('aria-pressed', 'false');
    for (const name of [/^Delivered:/, /^Read:/, /^Failed:/]) fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getAllByRole('button', { pressed: true }).filter(button => /on the chart/.test(button.getAttribute('aria-label') || ''))).toHaveLength(1);
  });

  it('reads Not reported, not zero, for a channel that sends no receipts', async () => {
    mocks.get.mockResolvedValue(list([{ ...batch, channel: 'sms', receiptSupport: 'none', counts: counts({ total: 10, sent: 10 }) }]));
    render(<TrackingHome />);
    const row = (await screen.findByRole('link', { name: 'Diwali offer' })).closest('tr')!;
    expect(within(row).getAllByText('Not reported')).toHaveLength(2);
  });

  it('says plainly when an outreach finished with nothing delivered', async () => {
    mocks.get.mockResolvedValue(list([
      { ...batch, id: 'a', name: 'All failed', counts: counts({ total: 10, failed: 10 }) },
      { ...batch, id: 'b', name: 'Some failed', counts: counts({ total: 10, delivered: 7, failed: 3 }) },
    ]));
    render(<TrackingHome />);
    expect(within((await screen.findByRole('link', { name: 'All failed' })).closest('tr')!).getByText('Not sent')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: 'Some failed' }).closest('tr')!).getByText('Finished with failures')).toBeInTheDocument();
  });
});
