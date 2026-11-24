import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  detectPromptAspectRatio,
  nearestAspectRatio,
  nearestResolution,
  prepareImageSettings,
} from '../../shared/imageSettings.js';
import type { ResolvedContentBrandContext } from '../services/content/ContentBrandContextService.js';

const saveBase64File = jest.fn<any>();
const getAdminOpenRouterKey = jest.fn<any>();

jest.unstable_mockModule('../utils/fileStorage.js', () => ({ saveBase64File, saveBufferFile: jest.fn() }));
jest.unstable_mockModule('../utils/geminiMediaPricing.js', () => ({ getImageDimensionsFromBase64: jest.fn(() => null) }));
jest.unstable_mockModule('../services/adminCredentialsService.js', () => ({ getAdminOpenRouterKey, updateAdminCredentialUsage: jest.fn() }));
jest.unstable_mockModule('../models/geminiUsages/functions.js', () => ({ createGeminiUsage: jest.fn(async () => ({ id: 1 })) }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({ getImageMarginPercentage: jest.fn(async () => 0) }));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({ getRechargeRate: jest.fn(async () => 1), getUsageRate: jest.fn(async () => 1) }));
jest.unstable_mockModule('../utils/currency.js', () => ({ getUsdToInrRate: jest.fn(() => 80), meteredCreditsFromUsd: (usd: number, rate: number) => (usd > 0 ? Math.max(1, Math.ceil(usd * 80 * rate - 1e-9)) : 0) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.unstable_mockModule('../services/insights/PricingService.js', () => ({ assertMediaPrice: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../services/content/BrandMediaComposer.js', () => ({
  loadApprovedBrandLogoReference: jest.fn(async () => null),
  buildBrandReferencePrompt: jest.fn((prompt: string) => prompt),
}));

const { buildImageGenerationPrompt, extractRequestedText, formatImageBrandContext, IMAGE_PROMPT_LIMIT } = await import('../services/content/ImagePromptBuilder.js');
const { OpenRouterImageGenerationWorker } = await import('../tools/openRouterImageGenerationWorker.js');

// The tester's request: a long prompt whose headline, colours and style come last.
const TESTER_PROMPT = [
  'Create a 4:5 portrait social media advertisement for Todle.',
  'A young professional sits at a desk, surrounded by floating sticky notes, calendars, reminders and chat bubbles drifting around their head, showing mental overload.',
  'Soft volumetric lighting, gentle depth of field, smooth rounded shapes, glossy materials and playful floating objects arranged in a balanced composition with clear negative space for typography at the top of the frame.',
  'Background: a dreamy gradient of purple, lavender and soft blue. Style: surreal 3D advertising illustration, not a photo.',
  'Headline: "Too many things on your mind?" Supporting line: "Maybe it\'s time to let Todle remember."',
].join(' ');

const brandContext = {
  businessProfile: {
    companyName: 'Todle', industry: 'Productivity software', description: 'Your Second Brain on WhatsApp',
    valueProposition: 'No downloads, no complex setup', restrictions: 'No health claims',
  },
  brandToolkit: {
    name: 'Todle', tagline: 'Every actor. One clear view.', description: 'Your Second Brain on WhatsApp',
    primaryColors: ['#6B4EFF'], secondaryColors: ['#B9A8FF'], fonts: { heading: 'Poppins' },
    visualInstructions: 'Rounded friendly shapes.', contentInstructions: 'Mention no downloads, no complex setup.',
    logoUrl: '/uploads/todle-logo.png', logoVisibility: true,
  },
  provenance: {},
} as unknown as ResolvedContentBrandContext;

describe('shared image settings', () => {
  it('reads a ratio written in the prompt and ignores times', () => {
    expect(detectPromptAspectRatio(TESTER_PROMPT)).toBe('4:5');
    expect(detectPromptAspectRatio('Meeting at 10:30 tomorrow')).toBeUndefined();
    expect(detectPromptAspectRatio(undefined)).toBeUndefined();
  });

  it('maps to the closest supported shape and size', () => {
    expect(nearestAspectRatio('4:5', ['1:1', '3:4', '16:9'])).toBe('3:4');
    expect(nearestAspectRatio('4:5', ['1:1', '4:5'])).toBe('4:5');
    expect(nearestResolution('4K', ['1K', '2K'])).toBe('2K');
    expect(nearestResolution('1K', ['2K', '4K'])).toBe('2K');
    expect(nearestResolution('4K', undefined)).toBeUndefined();
  });

  it('turns auto into the prompt ratio and reports every change', () => {
    expect(prepareImageSettings({ aspectRatio: 'auto', imageSize: '4K', prompt: TESTER_PROMPT }, { aspectRatios: ['1:1', '4:5'], resolutions: ['1K', '2K'] }))
      .toEqual({ aspectRatio: '4:5', imageSize: '2K', adjustments: ['4K is not supported by this model; using 2K.'] });
    // Nothing requested: no ratio is sent, so edits can keep the source image's shape.
    expect(prepareImageSettings({}, {})).toEqual({ adjustments: [] });
  });
});

describe('image prompt builder', () => {
  it('keeps the whole request first and the quoted text verbatim', () => {
    expect(TESTER_PROMPT.length).toBeGreaterThan(600);
    const prompt = buildImageGenerationPrompt({ userPrompt: TESTER_PROMPT, style: 'photorealistic', brandContext });
    expect(prompt.startsWith(`IMAGE REQUEST (follow exactly):\n${TESTER_PROMPT}`)).toBe(true);
    expect(prompt).toContain('quoted in the request: "Too many things on your mind?", "Maybe it\'s time to let Todle remember."');
    expect(prompt).toContain('Add no other words.');
    expect(prompt).toContain('Use it only where the request does not already name a style');
    expect(prompt.length).toBeLessThanOrEqual(IMAGE_PROMPT_LIMIT);
  });

  it('never sends taglines or product copy to the image model', () => {
    const prompt = buildImageGenerationPrompt({ userPrompt: TESTER_PROMPT, brandContext });
    for (const leaked of ['Every actor. One clear view.', 'Second Brain', 'No downloads']) expect(prompt).not.toContain(leaked);
    expect(prompt).toContain('#6B4EFF');
    expect(prompt).toContain('Do not add taglines, slogans, product claims');
    expect(formatImageBrandContext(brandContext)).toContain('Restrictions (mandatory): No health claims');
  });

  it('asks for no text when the request quotes none, and omits an auto style', () => {
    const prompt = buildImageGenerationPrompt({ userPrompt: 'A calm lavender desk scene', style: 'auto' });
    expect(prompt).toContain('If the request asks for no text, render none.');
    expect(prompt).not.toContain('quoted in the request');
    expect(prompt).not.toContain('style preset');
    expect(extractRequestedText('Say “Hello there” and "Bye now"')).toEqual(['Hello there', 'Bye now']);
  });

  it('treats chat and ads brand data the same way (visual only, no URL, no drawn logo)', () => {
    const chatContext = {
      brandToolkit: { name: 'Todle', primaryBrandColor: '#6B4EFF', secondaryBrandColor: '#B9A8FF', tagline: 'Every actor. One clear view.', voiceType: 'playful', logoUrl: '/uploads/todle-logo.png' },
      companyProfile: { companyName: 'Todle', website: 'https://todle.ai', description: 'Your Second Brain on WhatsApp' },
    };
    const brand = { brandToolkit: chatContext.brandToolkit, businessProfile: chatContext.companyProfile };
    const prompt = buildImageGenerationPrompt({ userPrompt: TESTER_PROMPT, brandContext: brand });
    expect(prompt.startsWith(`IMAGE REQUEST (follow exactly):\n${TESTER_PROMPT}`)).toBe(true);
    expect(prompt).toContain('#6B4EFF');
    for (const leaked of ['Every actor', 'todle.ai', 'Second Brain', 'watermark']) expect(prompt).not.toContain(leaked);
    expect(prompt).toContain('Reproduce it faithfully if it appears; never invent');
    const noLogo = buildImageGenerationPrompt({ userPrompt: 'A desk scene', brandContext: brand, includeLogo: false });
    expect(noLogo).toContain('Do not render a logo or wordmark.');
    expect(buildImageGenerationPrompt({ userPrompt: 'A desk scene', brandContext: { brandToolkit: null } })).not.toContain('BRAND REFERENCE');
  });

  it('does not turn a quoted look into words to paint', () => {
    const prompt = buildImageGenerationPrompt({ userPrompt: 'A "retro" travel poster with no text' });
    expect(prompt).not.toMatch(/render exactly/);
    expect(prompt).toContain('quotes that describe the look rather than words to show are not text');
    expect(prompt).toContain('If the request asks for no text, render none.');
  });
});

describe('Seedream request payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAdminOpenRouterKey.mockResolvedValue({ id: 1, apiKey: 'test-key', config: {} });
    saveBase64File.mockResolvedValue({ url: '/uploads/generated.png', fileName: 'generated.png' });
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('sends the full request, 4:5 and a supported resolution', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=', media_type: 'image/png' }],
    }), { status: 200 }));
    const prompt = buildImageGenerationPrompt({ userPrompt: TESTER_PROMPT, brandContext });
    const settings = prepareImageSettings({ aspectRatio: 'auto', imageSize: '4K', prompt: TESTER_PROMPT }, { aspectRatios: ['1:1', '3:4', '4:5'], resolutions: ['1K', '2K'] });

    await new OpenRouterImageGenerationWorker(undefined, undefined, 'bytedance-seed/seedream-5-0-pro').generateFromText(prompt, settings as unknown as Record<string, unknown>);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ aspect_ratio: '4:5', resolution: '2K' });
    for (const expected of ['Too many things on your mind?', "Maybe it's time to let Todle remember.", 'purple, lavender and soft blue', 'surreal 3D advertising illustration']) {
      expect(body.prompt).toContain(expected);
    }
    expect(body.prompt).not.toContain('Every actor. One clear view.');
  });
});
