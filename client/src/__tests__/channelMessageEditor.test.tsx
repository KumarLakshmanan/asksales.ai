import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelMessageEditor } from '@/components/outreach/ChannelMessageEditor';
import RichTextEditor from '@/components/RichTextEditor';
import { emailHtmlToText, plainTextToHtml } from '@/lib/messageFormatting';

afterEach(cleanup);

function WhatsApp({ initial = 'Hello customer', maxLength = 4096 }: { initial?: string; maxLength?: number }) {
  const [value, onChange] = useState(initial);
  return <ChannelMessageEditor channel="whatsapp" value={value} onChange={onChange} maxLength={maxLength} />;
}

describe('channel message editors', () => {
  it.each([['Bold', '*'], ['Italic', '_'], ['Strikethrough', '~'], ['Monospace', '```']])('applies and removes WhatsApp %s on the selected text', (action, marker) => {
    render(<WhatsApp />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    field.focus(); field.setSelectionRange(6, 14);
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(field).toHaveValue(`Hello ${marker}customer${marker}`);
    expect(field.selectionStart).toBe(6 + marker.length);
    expect(field.selectionEnd).toBe(14 + marker.length);
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(field).toHaveValue('Hello customer');
  });

  it('formats long WhatsApp replies using the 4096 reply limit and blocks edits that exceed it', () => {
    render(<WhatsApp initial={'A'.repeat(1025)} maxLength={1027} />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    field.setSelectionRange(0, 1025);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(field.value).toHaveLength(1027);
    field.setSelectionRange(1, 1026);
    fireEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(screen.getByRole('alert')).toHaveTextContent('length limit');
    expect(field.value).toHaveLength(1027);
  });

  it.each(['sms', 'instagram', 'facebook'] as const)('keeps %s as plain text without unsupported formatting', (channel) => {
    render(<ChannelMessageEditor channel={channel} value="Hello" onChange={vi.fn()} />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Hello');
  });

  it('keeps email line breaks and escapes plain text when entering rich editing', () => {
    expect(plainTextToHtml('Hello <customer> & team\nWelcome')).toBe('Hello &lt;customer&gt; &amp; team<br>Welcome');
    expect(emailHtmlToText('<p><b>Hello</b></p><ul><li>One</li><li>Two</li></ul><script>bad()</script>')).toBe('Hello\nOne\nTwo');
  });

  it('keeps the email caret and existing text nodes during controlled typing, and sanitizes external drafts', () => {
    function Email() { const [value, setValue] = useState('<p>Hello</p>'); return <RichTextEditor value={value} onChange={setValue} />; }
    const view = render(<Email />);
    const field = screen.getByRole('textbox');
    const text = field.querySelector('p')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 2); range.collapse(true);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.input(field);
    expect(field.querySelector('p')!.firstChild).toBe(text);
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(window.getSelection()!.anchorOffset).toBe(2);
    view.rerender(<RichTextEditor value='<p onclick="bad()">New draft</p><script>bad()</script>' onChange={vi.fn()} disabled />);
    expect(screen.getByRole('textbox').innerHTML).toBe('<p>New draft</p>');
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });
});
