import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OutreachMessageBubble } from '@/components/outreach/OutreachMessageBubble';
import type { OutreachMessage } from '@/components/outreach/types';

function message(attachments: NonNullable<OutreachMessage['attachments']>): OutreachMessage {
  return {
    id: 1,
    conversationId: 1,
    direction: 'inbound',
    content: '[Media or attachment]',
    attachments,
    status: 'delivered',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    isRead: false,
    createdAt: '2026-08-18T05:30:00.000Z',
  };
}

describe('outreach media attachment rendering', () => {
  it('uses authenticated inline URLs for images', () => {
    render(<OutreachMessageBubble channel="instagram" message={message([{
      id: 'image-1', fileName: 'story.jpg', mimeType: 'image/jpeg', url: '/download/image-1',
      inlineUrl: '/download/image-1?inline=true', status: 'ready',
    }])} />);
    expect(screen.getByRole('img', { name: 'story.jpg' })).toHaveAttribute('src', '/download/image-1?inline=true');
  });

  it('renders video controls and preserves a download action', () => {
    render(<OutreachMessageBubble channel="facebook" message={message([{
      id: 'video-1', fileName: 'post.mp4', mimeType: 'video/mp4', url: '/download/video-1',
      inlineUrl: '/download/video-1?inline=true', downloadUrl: '/download/video-1', status: 'ready',
    }])} />);
    const video = screen.getByLabelText('post.mp4');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', '/download/video-1?inline=true');
    expect(screen.getByRole('link', { name: 'Download post.mp4' })).toHaveAttribute('href', '/download/video-1');
  });

  it('shows an unavailable card only for terminal attachment state', () => {
    render(<OutreachMessageBubble channel="instagram" message={message([{
      id: 'failed-1', fileName: 'instagram-story-mention-1', mimeType: 'application/octet-stream',
      url: '/download/failed-1', status: 'failed',
    }])} />);
    expect(screen.getByText("Couldn't be saved")).toBeInTheDocument();
  });

  it.each([
    [{ status: 'failed', extractionError: 'WhatsApp attachment exceeds the 10 MB application limit.' }, 'Too large to save (over 10 MB)'],
    [{ status: 'quarantined', extractionError: 'File type "application/x-msdownload" is not allowed.' }, "This file type isn't supported"],
    [{ status: 'quarantined', extractionError: 'The attachment type does not match its contents.' }, "Blocked: the file's contents don't match its type"],
    [{ status: 'quarantined', extractionError: null }, 'Blocked for safety'],
  ])('explains why an attachment is unavailable: %o', (state, reason) => {
    render(<OutreachMessageBubble channel="whatsapp" message={message([{
      id: 'blocked-1', fileName: 'Deck.pdf', mimeType: 'application/pdf', url: '/download/blocked-1', ...state,
    }])} />);
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it.each(['whatsapp', 'instagram'] as const)('shows the provider failure reason for %s messages', (channel) => {
    render(<OutreachMessageBubble channel={channel} message={{
      ...message([]),
      direction: 'outbound',
      status: 'failed',
      errorMessage: 'The provider rejected this message.',
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The provider rejected this message.');
  });

  it('shows the reason a WhatsApp send needs manual review', () => {
    render(<OutreachMessageBubble channel="whatsapp" message={{
      ...message([]),
      direction: 'outbound',
      status: 'manual_review',
      errorMessage: 'Delivery outcome could not be confirmed.',
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Delivery outcome could not be confirmed.');
  });
});
