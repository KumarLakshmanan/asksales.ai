import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AdCopyCard from '@/components/content-cards/AdCopyCard';

describe('AdCopyCard media status', () => {
  it('does not label an optional image prompt as a generation failure', () => {
    render(
      <AdCopyCard
        title="Text-only ad"
        content={JSON.stringify({
          headline: 'A compliant headline',
          primaryText: 'Text-only ad copy',
          description: 'A description',
          callToAction: 'Learn More',
          displayUrl: 'https://example.com',
          imagePrompt: 'An optional future visual prompt',
          autoGenerateImageRequested: false,
        })}
        onGenerateImage={() => undefined}
      />
    );

    expect(screen.queryByText('Failed to generate image.')).not.toBeInTheDocument();
  });

  it('does not invent a failure receipt when a requested image is absent', () => {
    render(
      <AdCopyCard
        title="Image ad"
        content={JSON.stringify({
          headline: 'A compliant headline',
          primaryText: 'Image ad copy',
          description: 'A description',
          callToAction: 'Learn More',
          displayUrl: 'https://example.com',
          imagePrompt: 'A requested visual prompt',
          autoGenerateImageRequested: true,
        })}
        onGenerateImage={() => undefined}
      />
    );

    expect(screen.queryByText('Failed to generate image.')).not.toBeInTheDocument();
    expect(screen.getByText('No image attached yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
});
