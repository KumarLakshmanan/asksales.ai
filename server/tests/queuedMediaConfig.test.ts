import { describe, expect, it } from '@jest/globals';
import { queuedMediaConfig } from '../services/media/QueuedMediaConfig.js';

describe('queued media reviewed branding', () => {
  it.each(['image', 'video'] as const)('preserves the explicit %s config exclusion instead of restoring a toolkit logo', kind => {
    const key = kind === 'image' ? 'imageConfig' : 'videoConfig';
    expect(queuedMediaConfig({ [key]: { brandLogoUrl: null, aspectRatio: '1:1', negativePrompt: 'text, logos, watermarks' }, brandToolkit: { logoUrl: '/workspace-logo.png', logoUrls: ['/workspace-logo.png'] } }, kind))
      .toEqual({ brandLogoUrl: null, aspectRatio: '1:1', negativePrompt: 'text, logos, watermarks' });
    expect(queuedMediaConfig({ brandLogoUrl: null, [key]: { brandLogoUrl: '/old-logo.png' } }, kind).brandLogoUrl).toBeNull();
  });
  it('keeps an explicit reviewed logo ahead of toolkit defaults', () => {
    expect(queuedMediaConfig({ imageConfig: { brandLogoUrl: '/reviewed.png' }, brandToolkit: { logoUrl: '/default.png' } }, 'image').brandLogoUrl).toBe('/reviewed.png');
    expect(queuedMediaConfig({ brandLogoUrl: '/top-level.png', imageConfig: { brandLogoUrl: '/reviewed.png' } }, 'image').brandLogoUrl).toBe('/top-level.png');
  });
  it('retains enabled defaults and respects a hidden toolkit logo', () => {
    expect(queuedMediaConfig({ brandToolkit: { logoUrl: '/default.png' } }, 'image').brandLogoUrl).toBe('/default.png');
    expect(queuedMediaConfig({ brandToolkit: { logoVisibility: false, logoUrl: '/default.png' } }, 'image').brandLogoUrl).toBeNull();
  });
});
