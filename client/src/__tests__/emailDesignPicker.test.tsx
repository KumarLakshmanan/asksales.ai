import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmailDesignPicker, EmailDesignDefaults } from '@/components/outreach/EmailDesignPicker';
import { EmailDeliveryActivity } from '@/components/outreach/EmailDeliveryActivity';
import type { OutreachMessage } from '@/components/outreach/types';
import { stripEmailOpenTracking } from '../../../shared/emailFormatting';
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const actor = vi.hoisted(() => ({ scope: '9:7' }));
vi.mock('@/lib/api', () => ({ default: api }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => actor.scope }));
const data = () => ({ canManage: true, brand: { companyName: 'ORO', logoUrl: 'https://asksales.ai/uploads/logo.png', primaryColor: '#2563eb' }, preferences: { outreach: 'classic', assistant: 'letter', revision: 'initial' } });
function wrapper({ children }: { children: React.ReactNode }) { return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>; }
beforeEach(() => { actor.scope = '9:7'; api.get.mockReset().mockResolvedValue(data()); api.put.mockReset(); });
afterEach(cleanup);
describe('email design selection', () => {
  it('opens ten designs in a drawer, previews the selected layout, and applies only on confirmation', async () => {
    const apply = vi.fn();
    render(<EmailDesignPicker onChange={apply} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /Email design/ }));
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(10));
    fireEvent.click(screen.getByRole('radio', { name: /^Warm welcome/ }));
    expect(screen.getByTitle('Email design preview').getAttribute('srcdoc')).toContain('data-email-design="hospitality"');
    // Same-origin public brand assets use CORP; scripts remain sandboxed.
    expect(screen.getByTitle('Email design preview').getAttribute('sandbox')).toBe('allow-same-origin');
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use Warm welcome' }));
    expect(apply).toHaveBeenCalledWith('hospitality');
    expect(api.put).not.toHaveBeenCalled();
  });
  it('supports keyboard navigation and cancellation without changing the draft', async () => {
    const apply = vi.fn(); render(<EmailDesignPicker onChange={apply} />, { wrapper });
    const trigger = screen.getByRole('button', { name: /Email design/ });
    fireEvent.click(trigger);
    const classic = await screen.findByRole('radio', { name: /^Classic/ });
    fireEvent.keyDown(classic, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: /^Personal letter/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apply).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('retains separate outreach and assistant defaults with a revision on save', async () => {
    api.put.mockResolvedValue({ preferences: { outreach: 'classic', assistant: 'hospitality', revision: 'next' } });
    render(<EmailDesignDefaults />, { wrapper });
    const buttons = await screen.findAllByRole('button', { name: /Email design/ });
    fireEvent.click(buttons[1]);
    fireEvent.click(await screen.findByRole('radio', { name: /^Warm welcome/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use Warm welcome' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save email designs' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/settings/outreach/email-designs', { outreach: 'classic', assistant: 'hospitality', revision: 'initial' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Email designs saved');
  });
  it('lets staff preview defaults while keeping business changes owner-managed', async () => {
    api.get.mockResolvedValue({ ...data(), canManage: false });
    render(<EmailDesignDefaults />, { wrapper });
    await screen.findByText('Ask the business owner or billing admin to change these defaults.');
    expect(screen.getByRole('button', { name: 'Save email designs' })).toBeDisabled();
  });
});
describe('truthful email activity', () => {
  const message = { status: 'sent', sentAt: '2026-10-29T01:00:00Z', deliveredAt: null, readAt: null } as OutreachMessage;
  it('distinguishes an image load from confirmed delivery or reading', () => {
    render(<EmailDeliveryActivity message={{ ...message, emailTracking: { source: 'image_load', enabled: true, openedAt: '2026-10-29T01:01:00Z', openCount: 1 } }} />);
    expect(screen.getByText('Opened', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('· image loaded')).toBeTruthy();
    expect(screen.getByText(/Gmail does not provide delivery receipts/)).toBeTruthy();
    expect(screen.getAllByText('Not reported')).toHaveLength(1);
  });
  it('does not show delivered or opened when only a send receipt exists', () => {
    render(<EmailDeliveryActivity message={message} />);
    expect(screen.getByText('Sent', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText('Not reported')).toHaveLength(2);
  });
  it.each([['manual_review', 'Pending confirmation'], ['draft', 'Draft']])('does not let an image load override the %s workflow state', (status, label) => {
    render(<EmailDeliveryActivity message={{ ...message, status, emailTracking: { source: 'image_load', enabled: true, openedAt: '2026-10-29T01:01:00Z', openCount: 1 } }} />);
    expect(screen.getByText(label, { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText('Opened', { selector: 'span' })).toBeNull();
  });
  it('removes the tracking image from internal previews while retaining the real logo', () => {
    const html = '<img src="https://asksales.ai/uploads/oro.png"><p>Reply</p><img data-asksales-open-tracker="true" src="https://asksales.ai/api/email-events/open/token.gif">';
    expect(stripEmailOpenTracking(html)).toBe('<img src="https://asksales.ai/uploads/oro.png"><p>Reply</p>');
  });
});
