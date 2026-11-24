import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatThinkingBubble } from '@/components/chat/ChatThinkingBubble';
import { ToolExecutionCard } from '@/components/chat/ToolExecutionCard';
import type { Message } from '@/models/message';
import type { AgentStatus } from '@/models/agentStatus';

const user: Message = { id: 'user', role: 'user', content: 'Help me', timestamp: 1 };
const call = (agentType: Message['agentType'], toolName: string): Message => ({
  id: 'call', role: 'assistant', agentType, content: '', timestamp: 2,
  metadata: { isToolCall: true, toolName, toolCallId: 'tool-1', toolArgs: { query: 'example' } },
});
function Progress({ messages, agentType = 'icp_generation' }: { messages: Message[]; agentType?: AgentStatus['agentType'] }) {
  return <ChatThinkingBubble messages={messages} activeAgent={{ agentType, status: 'processing', progress: 0, currentTask: 'Processing with AI' }} isDarkMode />;
}

describe('one conversation progress surface', () => {
  it.each([
    ['icp_generation', 'generate_icp'], ['lead_generation', 'execute_lead_workflow'],
    ['content_studio', 'generate_image'], ['outreach', 'send_outreach_messages'],
    ['performance_marketing', 'generate_ad'],
  ] as const)('keeps only the tool accordion for %s', (agentType, toolName) => {
    const tool = call(agentType, toolName);
    const { container } = render(<><ToolExecutionCard message={tool} /><Progress messages={[user, tool]} agentType={agentType} /></>);
    expect(screen.queryByTestId('text-processing')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-tool-status="running"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('example')).toBeInTheDocument();
  });

  it('uses the same collapsed accordion while no tool exists yet', () => {
    render(<Progress messages={[user]} />);
    const button = screen.getByRole('button', { name: /Processing with AI/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not let an old turn or a different agent suppress current progress', () => {
    const { rerender } = render(<Progress messages={[call('icp_generation', 'generate_icp'), user]} />);
    expect(screen.getByTestId('text-processing')).toBeInTheDocument();
    rerender(<Progress messages={[user, call('lead_generation', 'execute_lead_workflow')]} />);
    expect(screen.getByTestId('text-processing')).toBeInTheDocument();
  });

  it('restores the compact fallback after the tool finishes', () => {
    const tool = call('icp_generation', 'generate_icp');
    render(<Progress messages={[user, tool, { ...tool, id: 'result', timestamp: 3, metadata: { ...tool.metadata, isToolCall: false, isToolResult: true, success: true } }]} />);
    expect(screen.getByTestId('text-processing')).toBeInTheDocument();
  });

  it('does not duplicate a streaming response indicator', () => {
    render(<Progress messages={[user, { id: 'stream', role: 'assistant', agentType: 'icp_generation', content: 'Hello', timestamp: 2, metadata: { streaming: true } }]} />);
    expect(screen.queryByTestId('text-processing')).not.toBeInTheDocument();
  });

  it.each(['running', 'queued', 'provider_succeeded'])('uses the linked widget accordion for %s', widgetStatus => {
    const tool = call('icp_generation', 'generate_icp');
    render(<Progress messages={[user, { ...tool, metadata: { ...tool.metadata, isToolCall: false, isToolResult: true, widgetStatus } }]} />);
    expect(screen.queryByTestId('text-processing')).not.toBeInTheDocument();
  });

  it('uses workflow progress without a second loading component', () => {
    render(<Progress agentType="lead_generation" messages={[user, {
      id: 'step', role: 'assistant', agentType: 'lead_generation', timestamp: 3, content: 'Searching', metadata: { isWorkflowStep: true, progress: 20 },
    }]} />);
    expect(screen.queryByTestId('text-processing')).not.toBeInTheDocument();
  });
});
