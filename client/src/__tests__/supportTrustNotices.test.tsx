import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentExtractionNotices } from '@/components/support/AttachmentExtractionNotices';
import { PrivacyAccessHistory } from '@/components/support/PrivacyAccessHistory';

describe('support attachment readability', () => {
  it('distinguishes unreadable and pending files without leaking extraction errors', () => {
    render(<AttachmentExtractionNotices attachments={[
      { id: '1', originalName: 'Unreadable.pdf', extractionStatus: 'failed' },
      { id: '2', originalName: 'Processing.pdf', extractionStatus: 'processing' },
      { id: '3', originalName: 'Ready.pdf', extractionStatus: 'success' },
    ]} />);
    expect(screen.getByText(/Contents could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/still being processed/)).toBeInTheDocument();
    expect(screen.queryByText('Ready.pdf:')).not.toBeInTheDocument();
  });
  it('does not invent readability status for legacy files', () => {
    const { container } = render(<AttachmentExtractionNotices attachments={[{ originalName: 'Legacy.pdf' }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('restricted access history', () => {
  it('shows actor, reason, action and timestamp', () => {
    const { container } = render(<PrivacyAccessHistory entries={[{ id: 1, actor: 'owner:7', action: 'reveal', reason: 'Confirm callback number', created_at: '2026-09-18T10:00:00Z' }]} />);
    expect(screen.getByText('owner:7')).toBeInTheDocument();
    expect(screen.getByText('Reason: Confirm callback number')).toBeInTheDocument();
    expect(screen.getByText('reveal')).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-09-18T10:00:00Z');
  });
  it('distinguishes unavailable access history from an empty period', () => {
    const view = render(<PrivacyAccessHistory />);
    expect(screen.getByText('Access history is currently unavailable.')).toBeInTheDocument();
    view.rerender(<PrivacyAccessHistory entries={[]} />);
    expect(screen.getByText('No restricted-content access recorded in this period.')).toBeInTheDocument();
  });
});
