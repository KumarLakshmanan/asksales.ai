/**
 * ToolExecutionCard Tests
 * Tests: retry button, copy-to-clipboard, expand/collapse, status display
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolExecutionCard } from '@/components/chat/ToolExecutionCard';
import type { Message } from '@/models/message';

function createToolMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 1,
    threadId: 1,
    userId: 1,
    role: 'assistant',
    content: 'Tool executed',
    agentType: 'orchestrator',
    metadata: {
      isToolResult: true,
      toolName: 'generate_image',
      success: true,
      toolArgs: { prompt: 'test image', width: 512 },
      toolOutput: { url: 'https://example.com/image.png' },
      durationMs: 1500,
      responseId: 'resp-1',
      ...overrides,
    },
    createdAt: new Date().toISOString(),
  } as unknown as Message;
}

describe('ToolExecutionCard', () => {
  let clipboardWriteTextSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clipboardWriteTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: clipboardWriteTextSpy,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool result display', () => {
    it('should render tool name with friendly label', () => {
      const message = createToolMessage({ toolName: 'generate_image' });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('Generate Image')).toBeTruthy();
    });

    it('should render success status', () => {
      const message = createToolMessage({ success: true });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('completed')).toBeTruthy();
    });

    it('shows cancelled reviews as cancelled, not the successful creation of their settings', () => {
      const message = createToolMessage({ success: true, toolOutput: { awaitingSubmission: true, widgetId: 42 } });
      render(<ToolExecutionCard message={message} widgetStatus="cancelled" />);
      expect(screen.getByText('cancelled')).toBeTruthy();
      expect(screen.queryByText('completed')).toBeNull();
      expect(screen.queryByText('awaiting confirmation')).toBeNull();
      expect(screen.getByRole('button', { name: /generate image/i }).getAttribute('data-tool-status')).toBe('cancelled');
    });

    it('should render failed status', () => {
      const message = createToolMessage({ success: false, error: 'API error' });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('failed')).toBeTruthy();
    });

    it('should render guard-blocked tools as gated rather than failed', () => {
      const message = createToolMessage({
        success: false,
        gated: true,
        error: 'Required work is still outstanding. No action was taken.',
        toolOutput: { status: 'gated' },
      });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('gated')).toBeTruthy();
      expect(screen.queryByText('failed')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /generate image/i }));
      expect(screen.getByText('Reason:')).toBeTruthy();
      expect(screen.queryByText('Error:')).toBeNull();
    });

    it('should show widget-backed tools as awaiting confirmation', () => {
      const message = createToolMessage({
        success: true,
        toolOutput: { awaitingSubmission: true, widgetId: 42 },
      });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('awaiting confirmation')).toBeTruthy();
      expect(screen.queryByText('completed')).toBeNull();
    });

    it('renders the linked review surface with an awaiting tool result', () => {
      const message = createToolMessage({
        success: true,
        toolOutput: { awaitingSubmission: true, widgetId: 42 },
      });
      render(
        <ToolExecutionCard
          message={message}
          reviewSurface={<section aria-label="Create Ad Copy agent task">Review ad settings</section>}
        />,
      );

      expect(screen.getByText('awaiting confirmation')).toBeTruthy();
      expect(screen.getByRole('region', { name: 'Create Ad Copy agent task' })).toBeTruthy();
      expect(screen.getByText('Review ad settings')).toBeTruthy();
    });

    it('should show a submitted widget-backed tool as running', () => {
      const message = createToolMessage({
        success: true,
        widgetStatus: 'running',
        toolOutput: { awaitingSubmission: false, widgetId: 42 },
      });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('running')).toBeTruthy();
      expect(screen.queryByText('completed')).toBeNull();
      expect(screen.queryByText('awaiting confirmation')).toBeNull();
    });

    it('should display duration when available', () => {
      const message = createToolMessage({ durationMs: 2500 });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('(2.5s)')).toBeTruthy();
    });
  });

  describe('expand/collapse', () => {
    it('should start collapsed', () => {
      const message = createToolMessage();
      render(<ToolExecutionCard message={message} />);

      expect(screen.queryByText('Parameters:')).toBeNull();
    });

    it('should expand on click', () => {
      const message = createToolMessage();
      render(<ToolExecutionCard message={message} />);

      const expandButton = screen.getByRole('button', { name: /generate image/i });
      fireEvent.click(expandButton);

      expect(screen.getByText('Parameters:')).toBeTruthy();
    });

    it('should show parameters when expanded', () => {
      const message = createToolMessage({
        toolArgs: { prompt: 'test image', width: 512 },
      });
      render(<ToolExecutionCard message={message} />);

      const expandButton = screen.getByRole('button', { name: /generate image/i });
      fireEvent.click(expandButton);

      expect(screen.getByText('prompt')).toBeTruthy();
      expect(screen.getByText('test image')).toBeTruthy();
      expect(screen.getByText('width')).toBeTruthy();
    });

    it('should show result when expanded', () => {
      const message = createToolMessage({
        toolOutput: { url: 'https://example.com/img.png' },
      });
      render(<ToolExecutionCard message={message} />);

      const expandButton = screen.getByRole('button', { name: /generate image/i });
      fireEvent.click(expandButton);

      expect(screen.getByText('Result:')).toBeTruthy();
      expect(screen.getByText('url')).toBeTruthy();
    });
  });

  describe('retry button', () => {
    it('should accept onRetry prop', () => {
      const onRetry = vi.fn();
      const message = createToolMessage({
        toolName: 'generate_image',
        toolArgs: { prompt: 'test' },
      });
      // Should render without errors when onRetry is provided
      render(<ToolExecutionCard message={message} onRetry={onRetry} />);
      expect(screen.getByText('Generate Image')).toBeTruthy();
    });

    it('should render without onRetry prop', () => {
      const message = createToolMessage();
      // Should render without errors when onRetry is not provided
      render(<ToolExecutionCard message={message} />);
      expect(screen.getByText('Generate Image')).toBeTruthy();
    });
  });

  describe('copy-to-clipboard', () => {
    it('should have navigator.clipboard available', () => {
      expect(navigator.clipboard).toBeDefined();
      expect(typeof navigator.clipboard.writeText).toBe('function');
    });
  });

  describe('failed tool result', () => {
    it('should replace provider rate-limit details with a safe message', () => {
      const message = createToolMessage({
        success: false,
        error: 'Rate limit exceeded',
      });
      render(<ToolExecutionCard message={message} />);

      const expandButton = screen.getByRole('button', { name: /generate image/i });
      fireEvent.click(expandButton);

      expect(screen.getByText('The AI service is temporarily unavailable. Please try this action again.')).toBeTruthy();
      expect(screen.queryByText('Rate limit exceeded')).toBeNull();
    });

    it('does not expose provider billing or project details', () => {
      const message = createToolMessage({
        success: false,
        error: 'Lightning dunning decision is deny for project: projects/740750721991',
      });
      render(<ToolExecutionCard message={message} />);

      fireEvent.click(screen.getByRole('button', { name: /generate image/i }));

      expect(screen.getByText('The AI service is temporarily unavailable. Please try this action again.')).toBeTruthy();
      expect(screen.queryByText(/projects\/740750721991/)).toBeNull();
      expect(screen.queryByText(/lightning dunning/i)).toBeNull();
    });
  });

  describe('unknown tool name', () => {
    it('should display raw tool name with underscores replaced by spaces', () => {
      const message = createToolMessage({ toolName: 'some_unknown_tool' });
      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('some unknown tool')).toBeTruthy();
    });
  });

  describe('in-progress tool call (non-result)', () => {
    it('should render the in-progress state with Wrench icon', () => {
      const message = {
        id: 1,
        threadId: 1,
        userId: 1,
        role: 'assistant',
        content: 'Executing...',
        agentType: 'content',
        metadata: {
          isToolResult: false,
          toolName: 'generate_image',
          toolArgs: { prompt: 'test' },
        },
        createdAt: new Date().toISOString(),
      } as unknown as Message;

      render(<ToolExecutionCard message={message} />);

      expect(screen.getByText('Generate Image')).toBeTruthy();
    });
  });
});
