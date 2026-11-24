/**
 * ChatInputArea Tests
 * Tests: disabled state visibility, processing placeholder, button states
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatInputArea } from '@/components/chat/ChatInputArea';

function createProps(overrides: Record<string, unknown> = {}) {
  const defaultProps = {
    input: '',
    setInput: vi.fn(),
    isProcessing: false,
    isListening: false,
    onSend: vi.fn(),
    onKeyDown: vi.fn(),
    onToggleVoice: vi.fn(),
    onFileImport: vi.fn(),
    textareaRef: { current: null },
    ...overrides,
  };
  return defaultProps;
}

describe('ChatInputArea', () => {
  it('keeps team management out of the composer without changing the draft', () => {
    const props = createProps({ input: 'Keep my draft' });
    render(<ChatInputArea {...props} />);
    expect(screen.queryByRole('button', { name: 'Choose agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
    expect(props.onSend).not.toHaveBeenCalled();
    expect(props.setInput).not.toHaveBeenCalled();
  });
  describe('agent mentions', () => {
    it('filters the picker and inserts an agent without sending a message', () => {
      const props = createProps({ input: '@out' });
      render(<ChatInputArea {...props} />);
      expect(screen.getAllByRole('option')).toHaveLength(1);
      fireEvent.click(screen.getByRole('option'));
      expect(props.setInput).toHaveBeenCalledWith('@emily ');
      expect(props.onSend).not.toHaveBeenCalled();
    });
    it('uses Enter to select before the normal send key handler and supports Escape', () => {
      const props = createProps({ input: '@sarah' });
      render(<ChatInputArea {...props} />);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(props.setInput).toHaveBeenCalledWith('@sarah ');
      expect(props.onKeyDown).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    it('does not treat a lead email or social handle inside a request as an agent selection', () => {
      render(<ChatInputArea {...createProps({ input: 'Find @hubspot and email hello@example.test' })} />);
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });
  describe('disabled/processing state', () => {
    it('keeps the controls legible when processing', () => {
      const props = createProps({ isProcessing: true });
      const { container } = render(<ChatInputArea {...props} />);

      const outerDiv = container.querySelector('.relative.group');
      expect(outerDiv?.className).not.toContain('opacity-60');
    });

    it('should not apply opacity when not processing', () => {
      const props = createProps({ isProcessing: false });
      const { container } = render(<ChatInputArea {...props} />);

      const outerDiv = container.querySelector('.relative.group');
      expect(outerDiv?.className).not.toContain('opacity-60');
    });

    it('should show the follow-up placeholder when processing', () => {
      const props = createProps({ isProcessing: true });
      render(<ChatInputArea {...props} />);

      const textarea = screen.getByPlaceholderText('Queue a follow-up or correction…');
      expect(textarea).toBeTruthy();
    });

    it('should show default placeholder when not processing', () => {
      const props = createProps({ isProcessing: false });
      render(<ChatInputArea {...props} />);

      const textarea = screen.getByPlaceholderText('Ask the team or @mention an agent…');
      expect(textarea).toBeTruthy();
    });

    it('should disable textarea when processing', () => {
      const props = createProps({ isProcessing: true });
      render(<ChatInputArea {...props} />);

      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeDisabled();
    });

    it('should disable import button when processing', () => {
      const props = createProps({ isProcessing: true });
      render(<ChatInputArea {...props} />);

      const importButton = screen.getByTitle('Attach files');
      expect(importButton).toBeDisabled();
    });

    it('should disable voice button when processing', () => {
      const props = createProps({ isProcessing: true });
      render(<ChatInputArea {...props} />);

      const voiceButton = screen.getByTitle('Start dictation');
      expect(voiceButton).toBeDisabled();
    });

    it('should disable send button when processing', () => {
      const props = createProps({ isProcessing: true });
      render(<ChatInputArea {...props} />);

      const sendButton = screen.getByTitle('Send message');
      expect(sendButton).toBeDisabled();
    });
  });

  describe('listening state', () => {
    it('should disable textarea when listening', () => {
      const props = createProps({ isListening: true });
      render(<ChatInputArea {...props} />);

      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeDisabled();
    });

    it('should show "Listening..." indicator when listening', () => {
      const props = createProps({ isListening: true });
      render(<ChatInputArea {...props} />);

      expect(screen.getByText('Listening...')).toBeTruthy();
    });

    it('should show MicOff icon when listening', () => {
      const props = createProps({ isListening: true });
      render(<ChatInputArea {...props} />);

      const stopButton = screen.getByTitle('Stop recording');
      expect(stopButton).toBeTruthy();
    });

    it('should disable send button when listening', () => {
      const props = createProps({ isListening: true });
      render(<ChatInputArea {...props} />);

      const sendButton = screen.getByTitle('Send message');
      expect(sendButton).toBeDisabled();
    });
  });

  describe('send button state', () => {
    it('should disable send when input is empty', () => {
      const props = createProps({ input: '' });
      render(<ChatInputArea {...props} />);

      const sendButton = screen.getByTitle('Send message');
      expect(sendButton).toBeDisabled();
    });

    it('should enable send when input has text and not processing', () => {
      const props = createProps({ input: 'Hello' });
      render(<ChatInputArea {...props} />);

      const sendButton = screen.getByTitle('Send message');
      expect(sendButton).not.toBeDisabled();
    });

    it('should disable send when input has text but is processing', () => {
      const props = createProps({ input: 'Hello', isProcessing: true });
      render(<ChatInputArea {...props} />);

      const sendButton = screen.getByTitle('Send message');
      expect(sendButton).toBeDisabled();
    });
  });

  describe('input behavior', () => {
    it('should call setInput when text is typed', () => {
      const props = createProps();
      render(<ChatInputArea {...props} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Hello' } });

      expect(props.setInput).toHaveBeenCalledWith('Hello');
    });

    it('should call onSend when send button is clicked', () => {
      const props = createProps({ input: 'Hello' });
      render(<ChatInputArea {...props} />);

      const sendButton = screen.getByTitle('Send message');
      fireEvent.click(sendButton);

      expect(props.onSend).toHaveBeenCalled();
    });

    it('should call onToggleVoice when voice button is clicked', () => {
      const props = createProps();
      render(<ChatInputArea {...props} />);

      const voiceButton = screen.getByTitle('Start dictation');
      fireEvent.click(voiceButton);

      expect(props.onToggleVoice).toHaveBeenCalled();
    });

    it('should call onKeyDown when key is pressed', () => {
      const props = createProps();
      render(<ChatInputArea {...props} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(props.onKeyDown).toHaveBeenCalled();
    });
  });

  describe('context indicator', () => {
    it('should render context indicator when provided', () => {
      const props = createProps({
        contextIndicator: <span data-testid="context">Context</span>,
      });
      render(<ChatInputArea {...props} />);

      expect(screen.getByTestId('context')).toBeTruthy();
    });
  });
});
