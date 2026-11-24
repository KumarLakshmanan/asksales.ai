import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutreachTab from '@/components/tabs/OutreachTab';

const workflow = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/contexts/WorkflowContext', () => ({ useOptionalWorkflow: () => workflow }));
beforeEach(() => { workflow.state = {}; });
afterEach(cleanup);

describe('Campaign outreach creation entry', () => {
  it('prepares the shared WhatsApp review instead of uploading or sending from a separate wizard', () => {
    const send = vi.fn();
    render(<OutreachTab icpId={1} threadId={42} onSendMessage={send} />);
    expect(screen.getByRole('combobox', { name: 'Campaign outreach channel' })).toHaveValue('whatsapp');
    expect(screen.getByText(/campaign uploads and CRM imports/)).toBeInTheDocument();
    expect(screen.getByText(/an approved WhatsApp template and its media/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare WhatsApp review' }));
    expect(send).toHaveBeenCalledWith(expect.stringContaining('WhatsApp outreach review for this campaign using its exact selected recipients'));
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Prepare only; do not send or search for new leads.'));
    expect(screen.queryByText(/Upload Leads/)).not.toBeInTheDocument();
  });
  it.each(['email','sms','instagram','facebook'])('keeps %s available through the same review', channel => {
    const send = vi.fn(); render(<OutreachTab icpId={1} threadId={42} onSendMessage={send} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Campaign outreach channel' }), { target: { value: channel } });
    fireEvent.click(screen.getByRole('button', { name: /Prepare .* review/ }));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain('per-outreach follow-up times');
    expect(send.mock.calls[0][0]).toContain('Keep global follow-up settings unchanged');
  });
  it('keeps existing legacy campaign reviews accessible', () => {
    workflow.state = { outreachNeedsReview: true, campaignId: 7 };
    render(<OutreachTab icpId={1} threadId={42} onSendMessage={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Review campaign delivery' })).toHaveAttribute('href','/dashboard/outreach/campaigns/7/review');
  });
  it('requires an ICP and a conversation before preparing a review', () => {
    const view = render(<OutreachTab threadId={42} onSendMessage={vi.fn()} />);
    expect(screen.getByText('ICP required for outreach')).toBeInTheDocument();
    view.rerender(<OutreachTab icpId={1} onSendMessage={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Prepare WhatsApp review' })).toBeDisabled();
  });
});
