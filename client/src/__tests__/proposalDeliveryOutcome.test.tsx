import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalDeliveryPanel } from '@/components/proposals/ProposalDeliveryPanel';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<object>(), api: mocks }));
vi.mock('@/components/support/ConversationEventTimeline', () => ({ ConversationEventTimeline: () => null }));
const proposal = { id: 501, revision: 2, title: 'Synthetic offer', proposalNumber: 'TEST-501', status: 'draft', recipientName: 'Synthetic Customer', recipientEmail: 'customer@example.test' };
beforeEach(() => vi.resetAllMocks());

async function deliver(state: string, refreshedStatus?: string) {
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/prepare-delivery')) return { proposal, ready: true, issues: [], targetFingerprint: 'target', reviewFingerprint: 'review', target: { channel: 'email', recipient: 'customer@example.test', providerAccountId: 'synthetic-account' } };
    if (url.endsWith('/approve')) return { revision: 2, approved: true, requirement: { reasons: [] } };
    if (url.endsWith('/send')) return { delivery: { state, channel: 'email', error: state === 'failed' || state === 'uncertain' ? 'Synthetic provider detail' : undefined } };
    throw new Error(`Unexpected test endpoint: ${url}`);
  });
  const refresh = vi.fn(async () => {
    if (refreshedStatus && mocks.post.mock.calls.some(([url]) => url.endsWith('/send'))) view.rerender(<ProposalDeliveryPanel proposal={{ ...proposal, status: refreshedStatus }} onRefresh={refresh} />);
  });
  const view = render(<ProposalDeliveryPanel proposal={proposal} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare delivery review' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Approve this exact version' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send approved proposal' }));
  return view;
}

describe('proposal delivery outcomes', () => {
  it('shows a definite failure and provider detail as an alert with a review action', async () => {
    await deliver('failed');
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic provider detail');
    expect(screen.getByRole('button', { name: 'Review delivery again' })).toBeVisible();
  });
  it('retains uncertainty guidance after refresh and offers no new delivery', async () => {
    await deliver('uncertain', 'delivery_unknown');
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery unconfirmed');
    expect(screen.getByRole('alert')).toHaveTextContent('reconcile');
    expect(screen.queryByRole('button', { name: /Prepare another delivery|Review delivery again/ })).not.toBeInTheDocument();
  });
  it('keeps an in-flight receipt pending without offering another delivery', async () => {
    await deliver('queued');
    expect(await screen.findByText('Delivery pending')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Prepare another delivery' })).not.toBeInTheDocument();
  });
  it('keeps the sent outcome and explicit next delivery available', async () => {
    await deliver('sent');
    expect(await screen.findByText('Delivery sent')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Prepare another delivery' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
