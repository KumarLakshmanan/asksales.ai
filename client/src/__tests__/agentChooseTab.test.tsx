import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentChooseTab from '@/components/tabs/AgentChooseTab';

const { toast, subscribe, setSelectedAgent } = vi.hoisted(() => ({
  toast: vi.fn(), subscribe: vi.fn(() => vi.fn()), setSelectedAgent: vi.fn(),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/contexts/AgentContext', () => ({ useAgent: () => ({ selectedAgent: null, setSelectedAgent }) }));

const recommendations = { lead_generation: 90, outreach: 80 };

describe('agent team hiring', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('submits once for rapid clicks and locks the selection until completion', async () => {
    let resolve!: () => void;
    const hire = vi.fn(() => new Promise<void>(res => { resolve = res; }));
    render(<AgentChooseTab recommendedAgentScores={recommendations} onHireMultipleAgents={hire} />);
    const button = screen.getByRole('button', { name: 'Hire Team & Start Workflow' });
    act(() => { button.click(); button.click(); });
    expect(hire).toHaveBeenCalledTimes(1);
    expect(hire).toHaveBeenCalledWith(['lead-generation', 'outreach'], ['Marcus Johnson', 'Emily Rodriguez']);
    expect(screen.getByRole('button', { name: 'Assembling Team…' })).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByText('Alex Chen'));
    expect(setSelectedAgent).not.toHaveBeenCalled();
    await act(async () => { resolve(); });
    expect(screen.queryByRole('button', { name: /Assembling Team|Hire Team & Start Workflow/ })).not.toBeInTheDocument();
  });

  it('keeps the selection and unlocks an explicit retry after a failed request', async () => {
    let reject!: (error: Error) => void;
    const hire = vi.fn().mockImplementationOnce(() => new Promise<void>((_, rej) => { reject = rej; })).mockResolvedValueOnce(undefined);
    render(<AgentChooseTab recommendedAgentScores={recommendations} onHireMultipleAgents={hire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hire Team & Start Workflow' }));
    await act(async () => { reject(new Error('Request rejected')); });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to Assemble Team', description: 'Request rejected' }));
    const retry = screen.getByRole('button', { name: 'Hire Team & Start Workflow' });
    expect(retry).toBeEnabled();
    await act(async () => { fireEvent.click(retry); });
    expect(hire).toHaveBeenCalledTimes(2);
    expect(hire.mock.calls[1]).toEqual(hire.mock.calls[0]);
  });

  it('cannot hire a team when no execution callback is configured', () => {
    render(<AgentChooseTab recommendedAgentScores={recommendations} />);
    expect(screen.getByRole('button', { name: 'Hire Team & Start Workflow' })).toBeDisabled();
  });
});
