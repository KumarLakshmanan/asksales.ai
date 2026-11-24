import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInputArea } from '@/components/chat/ChatInputArea';

function Composer({ listening = false, onVoice = vi.fn() }: { listening?: boolean; onVoice?: () => void }) {
  const [input, setInput] = useState('');
  const textareaRef = createRef<HTMLTextAreaElement>();
  return <ChatInputArea input={input} setInput={setInput} isProcessing={false} isListening={listening}
    onSend={vi.fn()} onKeyDown={vi.fn()} onToggleVoice={onVoice} onFileImport={vi.fn()}
    textareaRef={textareaRef} />;
}

describe('campaign composer controls', () => {
  it('keeps Stop recording available while dictation locks the draft', () => {
    const onVoice = vi.fn();
    render(<Composer listening onVoice={onVoice} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    const stop = screen.getByRole('button', { name: 'Stop recording' });
    expect(stop).toBeEnabled();
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(stop);
    expect(onVoice).toHaveBeenCalledOnce();
  });

  it('keeps prior agent mentions when another specialist is selected', () => {
    render(<Composer />);
    const message = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(message, { target: { value: '@marcus @sa' } });
    expect(screen.getByRole('listbox', { name: 'Campaign agents' })).toBeInTheDocument();
    fireEvent.keyDown(message, { key: 'Enter', code: 'Enter' });
    expect(message).toHaveValue('@marcus @sarah ');
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps an agent mention intact during IME confirmation: %j', event => {
    render(<Composer />);
    const message = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(message, { target: { value: '@sa' } });
    fireEvent.keyDown(message, { key: 'Enter', code: 'Enter', ...event });
    expect(message).toHaveValue('@sa');
    fireEvent.keyDown(message, { key: 'Enter', code: 'Enter' });
    expect(message).toHaveValue('@sarah ');
  });
});
