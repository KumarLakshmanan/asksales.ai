import React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalResumeRecovery } from '@/components/support/ApprovalResumeRecovery';
import { APPROVAL_RESUME_BLOCKED_MESSAGE } from '../../../shared/supportApprovalRecovery';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
const row = { id: 1, toolName: 'create_booking', threadId: 42, status: 'approved', resumeStatus: 'ready',
  expiresAt: null, updatedAt: '2026-10-23T00:00:00Z', message: APPROVAL_RESUME_BLOCKED_MESSAGE };
beforeEach(() => { mocks.get.mockReset(); });
describe('approval resume recovery diagnostics', () => {
  it('displays the blocked review and offers only a read refresh', async () => {
    mocks.get.mockResolvedValue([row]); render(<ApprovalResumeRecovery />);
    expect(await screen.findByText(APPROVAL_RESUME_BLOCKED_MESSAGE)).toBeVisible();
    expect(screen.getByText('create booking · Review #1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh approvals' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /resume|retry|send|execute/i })).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/api/support/ai/approval-recovery', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('shows failure instead of claiming an empty queue and recovers on refresh', async () => {
    mocks.get.mockRejectedValueOnce(new Error('synthetic outage')).mockResolvedValueOnce([]);
    const user = userEvent.setup(); render(<ApprovalResumeRecovery />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('No approvals are blocked before execution.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh approvals' }));
    expect(await screen.findByText('No approvals are blocked before execution.')).toBeVisible();
  });
  it('keeps prior diagnostics visibly stale when refresh fails', async () => {
    mocks.get.mockResolvedValueOnce([row]).mockRejectedValueOnce(new Error('synthetic outage'));
    const user = userEvent.setup(); render(<ApprovalResumeRecovery />);
    await screen.findByText(APPROVAL_RESUME_BLOCKED_MESSAGE);
    await user.click(screen.getByRole('button', { name: 'Refresh approvals' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('last loaded approvals are still shown');
    expect(screen.getByText(APPROVAL_RESUME_BLOCKED_MESSAGE)).toBeVisible();
  });
  it('aborts an unmounted business view and ignores a late response', async () => {
    let finish!: (rows: typeof row[]) => void;
    mocks.get.mockImplementation((_path, options) => {
      expect(options.signal.aborted).toBe(false);
      return new Promise(resolve => { finish = resolve; });
    });
    const view = render(<ApprovalResumeRecovery />);
    const signal = mocks.get.mock.calls[0][1].signal as AbortSignal;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { finish([row]); });
    expect(screen.queryByText(APPROVAL_RESUME_BLOCKED_MESSAGE)).not.toBeInTheDocument();
  });
});
