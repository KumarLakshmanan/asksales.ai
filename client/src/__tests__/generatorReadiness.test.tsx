import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GeneratorReadiness } from '@/components/content-studio/GeneratorReadiness';
const setup = vi.hoisted(() => ({ missingMessage: '', isReady: true, businessProfile: { website: 'https://example.test' }, toolkit: { website: '' } }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => setup }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => <p>Estimate fixture</p> }));
afterEach(() => { cleanup(); setup.missingMessage = ''; setup.isReady = true; });
it('keeps automatic saving disclosure visible when ready setup details are collapsed', () => {
  render(<GeneratorReadiness />);
  const disclosure = screen.getByText(/AI generation saves a draft/);
  expect(disclosure.closest('details')).toBeNull();
  expect(disclosure).toBeVisible();
  expect(screen.getByText('Brand context ready').closest('details')).not.toHaveAttribute('open');
});
it('opens setup requirements when a prerequisite is missing', () => {
  setup.missingMessage = 'Approve your Brand Toolkit'; setup.isReady = false;
  render(<GeneratorReadiness />);
  expect(screen.getByText('Complete generation setup').closest('details')).toHaveAttribute('open');
  expect(screen.getByText('Approve your Brand Toolkit')).toBeVisible();
});
