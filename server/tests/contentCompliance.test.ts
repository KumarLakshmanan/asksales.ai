import {
  ContentComplianceError,
  findTemplateVariables,
  parseStructuredContent,
  renderContentVariables,
  validateGeneratedContent,
} from '../services/content/ContentComplianceService.js';
import type { ResolvedContentBrandContext } from '../services/content/ContentBrandContextService.js';
import { formatContentBrandContext, formatMediaBrandContext } from '../services/content/ContentBrandContextService.js';

const context = {
  businessProfile: {
    id: 10,
    userId: 7,
    version: 1,
    isApproved: true,
    website: 'https://acme.example',
    restrictions: 'Do not say lifetime deal',
  },
  brandToolkit: {
    id: 20,
    userId: 7,
    name: 'Acme',
    voiceDonts: ['cheap and cheerful'],
    isDefault: true,
    isActive: true,
    isApproved: true,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  provenance: {
    schemaVersion: 1,
    resolvedAt: new Date().toISOString(),
    userId: 7,
    businessProfile: { id: 10, version: 1, selection: 'default', isApproved: true, updatedAt: null },
    brandToolkit: {
      id: 20,
      version: 1,
      selection: 'default',
      isApproved: true,
      updatedAt: new Date().toISOString(),
      isDefault: true,
      isActive: true,
    },
  },
} as ResolvedContentBrandContext;

describe('ContentComplianceService', () => {
  it.each(['twitter', 'instagram'])('counts the complete reviewed caption, CTA and hashtags for %s', platform => {
    const limit = platform === 'twitter' ? 280 : 2200;
    expect(() => validateGeneratedContent({ type: 'social', platform, context, output: { caption: 'a'.repeat(limit - 3), hashtags: ['Workflow'], callToAction: 'Read the notes.' } })).toThrow('exceeds');
    expect(() => validateGeneratedContent({ type: 'social', platform, context, output: { caption: 'Read the notes. #Workflow', hashtags: ['Workflow'], callToAction: 'Read the notes.' } })).not.toThrow();
  });
  it('includes mandatory content, visual, and logo policies in generation context', () => {
    const formatted = formatContentBrandContext({
      ...context,
      brandToolkit: {
        ...context.brandToolkit,
        contentInstructions: 'Use only approved enterprise claims.',
        visualInstructions: 'Use a dark navy canvas with violet accents.',
        logoUsageGuidelines: 'Keep the approved logo unmodified with clear space.',
        logoVisibility: true,
        logoUrl: '/uploads/brand/logo.png',
      },
    });

    expect(formatted).toContain('Global content instructions (mandatory): Use only approved enterprise claims.');
    expect(formatted).toContain('Visual instructions for image and video (mandatory): Use a dark navy canvas with violet accents.');
    expect(formatted).toContain('Logo usage rules (mandatory): Keep the approved logo unmodified with clear space.');
    expect(formatted).toContain('Never redraw, restyle, recolor, crop, stretch, or invent a substitute wordmark.');
  });

  it('keeps image and video brand context provider-safe without dropping visual policies', () => {
    const formatted = formatMediaBrandContext({
      ...context,
      brandToolkit: {
        ...context.brandToolkit,
        primaryBrandColor: '#14213D',
        visualInstructions: 'Use cinematic enterprise scenes with violet accents.',
        logoUsageGuidelines: 'Keep the approved logo unmodified with clear space.',
        logoVisibility: true,
        logoUrl: '/uploads/brand/logo.png',
      },
    });

    expect(formatted.length).toBeLessThanOrEqual(2_700);
    expect(formatted).toContain('Use cinematic enterprise scenes with violet accents.');
    expect(formatted).not.toContain('/uploads/brand/logo.png');
    expect(formatted).toContain('approved logo image is attached to the media-generation request as a visual asset reference');
    expect(formatted).toContain('Analyze that exact asset before generation');
    expect(formatted).toContain('no post-generation corner overlay or compositor is applied');
  });

  it('parses fenced structured output with the shared schema', () => {
    const parsed = parseStructuredContent(
      'sms',
      '```json\n{"message":"Hi {{first_name}}, visit {{link}}"}\n```',
    );
    expect(parsed.message).toContain('{{first_name}}');
  });

  it('treats null optional model fields as omitted', () => {
    const sms = parseStructuredContent('sms', {
      message: 'QA complete',
      characterCount: null,
      imagePrompt: null,
    });
    expect(sms).toEqual({ message: 'QA complete' });

    const social = parseStructuredContent('social', {
      caption: 'QA complete',
      hashtags: null,
      keywords: null,
      imagePrompt: null,
      videoPrompt: null,
    });
    expect(social).toEqual({ caption: 'QA complete', hashtags: [], keywords: [] });
  });

  it('detects canonical variables and blocks unresolved delivery values', () => {
    expect(findTemplateVariables('Hi {{ first_name }}, {{company_name}}')).toEqual([
      'first_name',
      'company_name',
    ]);
    expect(() =>
      renderContentVariables('Hi {{first_name}} from {{company_name}}', {
        first_name: 'Asha',
      }),
    ).toThrow(ContentComplianceError);
  });

  it('blocks noncanonical variables and explicit brand restrictions', () => {
    expect(() =>
      validateGeneratedContent({
        type: 'email',
        output: {
          subject: 'Offer',
          body: 'Hi {{surprise_offer}}, get our lifetime deal.',
        },
        context,
      }),
    ).toThrow(ContentComplianceError);
  });

  it('enforces natural-language prohibition prefixes from business restrictions', () => {
    const restrictedContext = {
      ...context,
      businessProfile: {
        ...context.businessProfile,
        restrictions: 'Do not mention hidden fees; Avoid medical claims',
      },
    };
    expect(() =>
      validateGeneratedContent({
        type: 'email',
        output: {
          subject: 'Pricing',
          body: 'There are no hidden fees in this plan.',
        },
        context: restrictedContext,
      }),
    ).toThrow(ContentComplianceError);
  });

  it('blocks unsafe URLs and unsupported absolute claims', () => {
    expect(() =>
      validateGeneratedContent({
        type: 'ad',
        platform: 'facebook',
        output: {
          headline: 'Guaranteed results',
          primaryText: '100% guaranteed. javascript:alert(1)',
          description: 'Try it',
          callToAction: 'Learn More',
          imagePrompt: 'Product',
        },
        context,
      }),
    ).toThrow(ContentComplianceError);
  });

  it('enforces provider-specific paid-ad limits and approved HTTPS domains', () => {
    const websiteContext = {
      ...context,
      businessProfile: {
        ...context.businessProfile,
        website: 'https://acme.example',
      },
    };
    expect(() =>
      validateGeneratedContent({
        type: 'ad',
        platform: 'google',
        output: {
          headline: 'A headline that is longer than thirty characters',
          primaryText: 'Approved offer',
          description: 'A concise description',
          callToAction: 'Learn More',
          displayUrl: 'https://acme.example/offer',
          imagePrompt: 'Approved product visual',
        },
        context: websiteContext,
      }),
    ).toThrow(ContentComplianceError);
    expect(() =>
      validateGeneratedContent({
        type: 'ad',
        platform: 'google',
        output: {
          headline: 'Approved offer',
          primaryText: 'Approved offer',
          description: 'A concise description',
          callToAction: 'Learn More',
          displayUrl: 'http://acme.example/offer',
          imagePrompt: 'Approved product visual',
        },
        context: websiteContext,
      }),
    ).toThrow(ContentComplianceError);
  });

  it('allows a compliant ad only on the approved destination domain', () => {
    expect(() =>
      validateGeneratedContent({
        type: 'ad',
        platform: 'facebook',
        output: {
          headline: 'Build a better workflow',
          primaryText: 'See how Acme can simplify your next project.',
          description: 'A practical team workflow.',
          callToAction: 'Learn More',
          displayUrl: 'https://acme.example/solutions',
          imagePrompt: 'A clean on-brand workflow illustration',
          keywords: [],
        },
        context,
      }),
    ).not.toThrow();

    expect(() =>
      validateGeneratedContent({
        type: 'ad',
        platform: 'facebook',
        output: {
          headline: 'Build a better workflow',
          primaryText: 'See how Acme can simplify your next project.',
          description: 'A practical team workflow.',
          callToAction: 'Learn More',
          displayUrl: 'https://unapproved.example/solutions',
          imagePrompt: 'A clean on-brand workflow illustration',
          keywords: [],
        },
        context,
      }),
    ).toThrow(ContentComplianceError);
  });
});
