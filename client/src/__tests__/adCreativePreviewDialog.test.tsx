import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdCreativePreviewDialog, AdCreativePreviewWorkspace } from '@/components/performance-marketing/AdCreativePreviewDialog';

afterEach(cleanup);

describe('Paid Ads creative preview', () => {
  it('shows provider creative evidence and switches placements and ads without mutating delivery', () => {
    const onOpenChange = vi.fn();
    render(
      <AdCreativePreviewDialog
        open
        onOpenChange={onOpenChange}
        scopeName="Warm audience"
        scopeType="ad set"
        identity={{ facebookPageName: 'AskSales Page', instagramUsername: 'asksales' }}
        ads={[
          {
            id: 'ad-1',
            name: 'Proof creative',
            effectiveStatus: 'ACTIVE',
            creative: {
              name: 'AskSales',
              primaryText: 'Let AI qualify every inbound lead.',
              headline: 'Reply while intent is high',
              description: 'A faster path from click to conversation.',
              imageUrl: 'https://cdn.example.com/creative.jpg',
              destinationUrl: 'https://asksales.ai/demo',
              callToActionType: 'LEARN_MORE',
            },
          },
          { id: 'ad-2', name: 'Trust creative', effectiveStatus: 'PAUSED' },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Creative preview · Warm audience' })).toBeInTheDocument();
    expect(screen.getByText(/Read-only provider preview/)).toBeInTheDocument();
    expect(screen.getByText(/No delivery settings are changed/)).toBeInTheDocument();
    expect(screen.getByText('AskSales Page')).toBeInTheDocument();
    expect(screen.getByLabelText('Facebook preview for Proof creative')).toBeInTheDocument();
    expect(screen.getByAltText('Creative for Proof creative')).toHaveAttribute('src', 'https://cdn.example.com/creative.jpg');
    expect(screen.getByText('Reply while intent is high')).toBeInTheDocument();
    expect(screen.getByText('Learn More')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
    expect(screen.getByLabelText('Instagram preview for Proof creative')).toBeInTheDocument();
    expect(screen.getAllByText('@asksales')).not.toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Trust creative/ }));
    expect(screen.getByLabelText('Instagram preview for Trust creative')).toBeInTheDocument();
    expect(screen.getByText(/copy and media were not included in the latest cached provider evidence/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps an empty hierarchy truthful and does not start synchronization', () => {
    render(
      <AdCreativePreviewDialog
        open
        onOpenChange={vi.fn()}
        scopeName="Campaign without ads"
        scopeType="campaign"
        ads={[]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No ads are available to preview' })).toBeInTheDocument();
    expect(screen.getByText(/Preview never starts a sync or changes the campaign/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync/i })).not.toBeInTheDocument();
  });

  it('tries the saved thumbnail when the primary provider media link fails', () => {
    render(<AdCreativePreviewWorkspace ads={[{ id: '1', name: 'Cached creative', creative: { primaryText: 'Saved ad copy', imageUrl: 'https://cdn.example.test/expired.jpg', thumbnailUrl: 'https://cdn.example.test/thumbnail.jpg' } }]} />);
    const image = screen.getByAltText('Creative for Cached creative');
    expect(image).toHaveAttribute('src', 'https://cdn.example.test/expired.jpg');
    fireEvent.error(image);
    expect(screen.getByAltText('Creative for Cached creative')).toHaveAttribute('src', 'https://cdn.example.test/thumbnail.jpg');
    expect(screen.queryByText('Media preview unavailable')).not.toBeInTheDocument();
    expect(screen.getByText('Saved ad copy')).toBeVisible();
  });

  it('discloses failed media while retaining saved copy and resets when evidence is replaced', () => {
    const creative = { primaryText: 'Saved ad copy', imageUrl: 'https://cdn.example.test/expired.jpg', thumbnailUrl: 'https://cdn.example.test/expired-thumbnail.jpg' };
    const view = render(<AdCreativePreviewWorkspace ads={[{ id: '1', name: 'Cached creative', creative }]} />);
    fireEvent.error(screen.getByAltText('Creative for Cached creative'));
    fireEvent.error(screen.getByAltText('Creative for Cached creative'));
    expect(screen.queryByAltText('Creative for Cached creative')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('The saved provider media links could not be loaded.');
    expect(screen.getByRole('status')).toHaveTextContent('The live ad was not changed.');
    expect(screen.getByText('1/1 have saved creative evidence')).toBeVisible();
    expect(screen.getByText('Saved ad copy')).toBeVisible();
    expect(screen.queryByRole('button', { name: /sync|refresh|publish/i })).not.toBeInTheDocument();
    view.rerender(<AdCreativePreviewWorkspace ads={[{ id: '1', name: 'Cached creative', creative: { ...creative, imageUrl: 'https://cdn.example.test/replaced.jpg' } }]} />);
    expect(screen.getByAltText('Creative for Cached creative')).toHaveAttribute('src', 'https://cdn.example.test/replaced.jpg');
    expect(screen.queryByText('Media preview unavailable')).not.toBeInTheDocument();
  });
});
