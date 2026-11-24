import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailComposeBuilder } from '@/components/outreach/EmailComposeBuilder';

vi.mock('react-simple-wysiwyg', () => ({
  default: ({ value, onChange }: { value: string; onChange: (event: { target: { value: string } }) => void }) =>
    <textarea aria-label="Rich text HTML" value={value} onChange={onChange} />,
}));
vi.mock('@/components/email-builder/DnDEmailBuilder', () => ({ default: () => null, blocksToHtml: vi.fn(), blocksToPlainText: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

describe('email composer text alternative', () => {
  it.each(['richtext', 'html'])('keeps line breaks when editing in the %s tab', tab => {
    const onMessageChange = vi.fn();
    const onHtmlContentChange = vi.fn();
    render(<EmailComposeBuilder message="" htmlContent="" subject="Formatting test"
      onMessageChange={onMessageChange} onHtmlContentChange={onHtmlContentChange}
      onSubjectChange={vi.fn()} onSend={vi.fn()} />);
    if (tab === 'html') fireEvent.mouseDown(screen.getByRole('tab', { name: 'HTML' }), { button: 0, ctrlKey: false });
    const editor = tab === 'html' ? screen.getByPlaceholderText('<html>...</html>') : screen.getByRole('textbox', { name: 'Rich text HTML' });
    const html = '<div>Hi Uma,</div><div><br></div><div>HR teams face delays.</div><div><br></div><div>Best regards,<br>Shiv Das<br>Founder, Aimplify</div>';
    fireEvent.change(editor, { target: { value: html } });
    expect(onHtmlContentChange).toHaveBeenCalledWith(html);
    expect(onMessageChange).toHaveBeenCalledWith('Hi Uma,\n\nHR teams face delays.\n\nBest regards,\nShiv Das\nFounder, Aimplify');
  });
});
