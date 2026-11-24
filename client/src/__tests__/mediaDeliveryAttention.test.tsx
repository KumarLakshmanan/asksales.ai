import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaDeliveryAttention, type MediaDeliveryAttentionItem } from '@/components/support/MediaDeliveryAttention';

afterEach(cleanup);
const now = Date.parse('2026-09-23T12:00:00Z');
const item: MediaDeliveryAttentionItem = { id: 1, name: 'Villa', channel: 'instagram', status: 'failed', updated_at: '2026-09-23T01:00:00Z' };
function setup(deliveries: MediaDeliveryAttentionItem[], loadError = false) {
  const actions = { onReload: vi.fn(), onRetry: vi.fn(), onVerify: vi.fn(), onConnections: vi.fn() };
  render(<MediaDeliveryAttention {...actions} deliveries={deliveries} saving={false} loadError={loadError} now={now} />);
  return actions;
}
describe('media delivery attention panel', () => {
  it('keeps old failures collapsed and clearly reports unresolved outcomes without dismissing them', () => {
    setup([item, { ...item, id: 2, name: 'Old photo', status: 'uncertain', updated_at: '2026-08-29T01:00:00Z' }]);
    expect(screen.getByText('Recent attempts (1)').closest('details')).toHaveAttribute('open');
    const history = screen.getByText('Older attempts (1) · 1 need outcome verification').closest('details');
    expect(history).not.toHaveAttribute('open');
    expect(screen.getByText('1 failed · 1 unconfirmed · 1 updated in the last 7 days')).toBeVisible();
    expect(screen.getByText(/collapsing them does not mark them delivered/)).toBeVisible();
  });
  it('shows a connection action rather than blindly retrying an authorization failure', () => {
    const actions = setup([{ ...item, recovery_action: 'connection', retry_eligible: true, failure_summary: 'Meta rejected the connection token.' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Review connection' }));
    expect(actions.onConnections).toHaveBeenCalledOnce();
    expect(actions.onRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry image' })).not.toBeInTheDocument();
  });
  it('uncertain attempts can only be verified even if a stale response says retryable', () => {
    const attempt = { ...item, status: 'uncertain' as const, retry_eligible: true, recovery_action: 'retry' as const };
    const actions = setup([attempt]);
    fireEvent.click(screen.getByRole('button', { name: 'Verify outcome' }));
    expect(actions.onVerify).toHaveBeenCalledWith(attempt);
    expect(screen.queryByRole('button', { name: 'Retry image' })).not.toBeInTheDocument();
  });
  it('requires explicit server eligibility before offering retry, and explains missing account binding', () => {
    setup([{ ...item, recovery_action: 'new_reply', account_binding_required: true, retry_eligible: false }]);
    expect(screen.getByText(/no verified sending account/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry image' })).not.toBeInTheDocument();
  });
  it('retries only the selected eligible failed image on an owner action', () => {
    const attempt = { ...item, recovery_action: 'retry' as const, retry_eligible: true };
    const actions = setup([attempt]);
    expect(actions.onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
    expect(actions.onRetry).toHaveBeenCalledWith(attempt);
  });
  it('offers reload on failed diagnostics and hides the panel when there are no issues', () => {
    const actions = setup([], true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(actions.onReload).toHaveBeenCalledOnce();
    cleanup(); setup([]);
    expect(screen.queryByText('Media delivery needs attention')).not.toBeInTheDocument();
  });
});
