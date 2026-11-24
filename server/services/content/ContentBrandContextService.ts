import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { companySettings, type CompanySettings } from '../../models/companySettings/schema.js';
import {
  brandToolkitsTable,
  type BrandToolkitRecord,
} from '../../models/brandToolkits/schema.js';

export type BrandContextSelection = 'requested' | 'default';

export interface ContentBrandProvenance {
  schemaVersion: 1;
  resolvedAt: string;
  userId: number;
  businessProfile: {
    id: number;
    version: number;
    selection: BrandContextSelection;
    isApproved: boolean;
    updatedAt: string | null;
  };
  brandToolkit: {
    id: number;
    version: number;
    selection: BrandContextSelection;
    isApproved: boolean;
    updatedAt: string;
    isDefault: boolean;
    isActive: boolean;
  };
}

export interface ResolvedContentBrandContext {
  businessProfile: CompanySettings;
  brandToolkit: BrandToolkitRecord;
  provenance: ContentBrandProvenance;
}

export class ContentBrandContextError extends Error {
  constructor(
    public readonly code:
      | 'BUSINESS_PROFILE_REQUIRED'
      | 'BUSINESS_PROFILE_NOT_FOUND'
      | 'BUSINESS_PROFILE_NOT_APPROVED'
      | 'BRAND_TOOLKIT_REQUIRED'
      | 'BRAND_TOOLKIT_NOT_FOUND'
      | 'BRAND_TOOLKIT_NOT_APPROVED'
      | 'BRAND_TOOLKIT_INACTIVE',
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ContentBrandContextError';
  }
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function optionalPositiveId(value: number | string | null | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

/**
 * Resolve the authoritative business and brand records for content generation.
 *
 * An omitted ID resolves to the user's default record. An explicit ID is always
 * queried together with user_id, preventing cross-tenant context injection.
 * Brand toolkits must be active. Until an explicit approval column is available,
 * the default active toolkit is the approved/default fallback.
 */
export async function resolveContentBrandContext(
  userId: number,
  options: {
    businessProfileId?: number | string | null;
    brandToolkitId?: number | string | null;
  } = {},
  queryDb: typeof db = db,
): Promise<ResolvedContentBrandContext> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ContentBrandContextError(
      'BUSINESS_PROFILE_REQUIRED',
      'Authentication is required to resolve brand context.',
      401,
    );
  }

  const scope = requireBusinessScope();
  const requestedBusinessId = optionalPositiveId(options.businessProfileId) ?? scope.businessProfileId;
  if (scope.userId !== userId || requestedBusinessId !== scope.businessProfileId) {
    throw new ContentBrandContextError('BUSINESS_PROFILE_NOT_FOUND', 'Select this business before generating content for it.', 403);
  }
  if (Number.isNaN(requestedBusinessId)) {
    throw new ContentBrandContextError(
      'BUSINESS_PROFILE_NOT_FOUND',
      'The selected business profile is invalid.',
      400,
    );
  }
  const businessRows = await queryDb
    .select()
    .from(companySettings)
    .where(
      requestedBusinessId
        ? and(
            eq(companySettings.id, requestedBusinessId),
            eq(companySettings.userId, userId),
          )
        : and(
            eq(companySettings.userId, userId),
            eq(companySettings.isDefault, true),
          ),
    )
    .orderBy(desc(companySettings.isDefault), desc(companySettings.updatedAt))
    .limit(1);
  const businessProfile = businessRows[0];
  if (!businessProfile) {
    throw new ContentBrandContextError(
      requestedBusinessId ? 'BUSINESS_PROFILE_NOT_FOUND' : 'BUSINESS_PROFILE_REQUIRED',
      requestedBusinessId
        ? 'The selected business profile was not found.'
        : 'Create and select a default business profile before generating content.',
      requestedBusinessId ? 404 : 409,
    );
  }
  if (businessProfile.isApproved !== true) {
    throw new ContentBrandContextError(
      'BUSINESS_PROFILE_NOT_APPROVED',
      'Approve the selected business profile before generating content.',
      409,
    );
  }

  const requestedToolkitId = optionalPositiveId(options.brandToolkitId);
  if (Number.isNaN(requestedToolkitId)) {
    throw new ContentBrandContextError(
      'BRAND_TOOLKIT_NOT_FOUND',
      'The selected Brand Toolkit is invalid.',
      400,
    );
  }
  const toolkitRows = await queryDb
    .select()
    .from(brandToolkitsTable)
    .where(
      requestedToolkitId
        ? and(
            eq(brandToolkitsTable.id, requestedToolkitId),
            eq(brandToolkitsTable.userId, userId),
          )
        : and(
            eq(brandToolkitsTable.userId, userId),
            eq(brandToolkitsTable.isDefault, true),
          ),
    )
    .orderBy(desc(brandToolkitsTable.isDefault), desc(brandToolkitsTable.updatedAt))
    .limit(1);
  const brandToolkit = toolkitRows[0];
  if (!brandToolkit) {
    throw new ContentBrandContextError(
      requestedToolkitId ? 'BRAND_TOOLKIT_NOT_FOUND' : 'BRAND_TOOLKIT_REQUIRED',
      requestedToolkitId
        ? 'The selected Brand Toolkit was not found.'
        : 'Create and select an active default Brand Toolkit before generating content.',
      requestedToolkitId ? 404 : 409,
    );
  }
  if (brandToolkit.isActive === false) {
    throw new ContentBrandContextError(
      'BRAND_TOOLKIT_INACTIVE',
      'The selected Brand Toolkit is inactive.',
      409,
    );
  }
  if (brandToolkit.isApproved !== true && brandToolkit.isDefault !== true) {
    throw new ContentBrandContextError(
      'BRAND_TOOLKIT_NOT_APPROVED',
      'Approve the selected Brand Toolkit or make it the default before generating content.',
      409,
    );
  }

  return {
    businessProfile,
    brandToolkit,
    provenance: {
      schemaVersion: 1,
      resolvedAt: new Date().toISOString(),
      userId,
      businessProfile: {
        id: businessProfile.id,
        version: businessProfile.version,
        selection: requestedBusinessId ? 'requested' : 'default',
        isApproved: businessProfile.isApproved,
        updatedAt: iso(businessProfile.updatedAt),
      },
      brandToolkit: {
        id: brandToolkit.id,
        version: brandToolkit.version,
        selection: requestedToolkitId ? 'requested' : 'default',
        isApproved: brandToolkit.isApproved,
        updatedAt: iso(brandToolkit.updatedAt) || new Date(0).toISOString(),
        isDefault: brandToolkit.isDefault === true,
        isActive: brandToolkit.isActive !== false,
      },
    },
  };
}

function compactJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * Prompt-safe, complete context. Delimiters make it explicit that these values
 * are data and policy, not user instructions that may override system rules.
 */
export function formatContentBrandContext(
  context: ResolvedContentBrandContext,
): string {
  const business = context.businessProfile;
  const toolkit = context.brandToolkit;
  return `<approved_business_and_brand_context>
BUSINESS PROFILE
- Name: ${business.companyName || business.businessName || business.name || ''}
- Profile type: ${business.profileType || ''}
- Industry: ${business.industry || ''}
- Workspace type: ${business.workspaceType || ''}
- Application uses: ${compactJson(business.applicationUses)}
- First goal: ${business.setupGoal || ''}
- Current tools: ${business.currentTools || ''}
- Sub-industry: ${business.subIndustry || ''}
- Website: ${business.website || ''}
- Description: ${business.description || ''}
- Target market: ${business.targetMarket || ''}
- Value proposition: ${business.valueProposition || ''}
- Customer type: ${business.customerType || ''}
- Target regions: ${business.targetRegions || ''}
- Key buyer roles: ${business.keyBuyerRoles || ''}
- Business goals: ${business.businessGoals || ''}
- Preferred channels: ${business.preferredChannels || ''}
- Brand tone: ${business.brandTone || ''}
- Restrictions and claim constraints (mandatory): ${business.restrictions || ''}

BRAND TOOLKIT
- Brand name: ${toolkit.name}
- Description: ${toolkit.description || ''}
- Tagline: ${toolkit.tagline || ''}
- Mission: ${toolkit.missionStatement || ''}
- Values: ${compactJson(toolkit.brandValues)}
- Keywords: ${compactJson(toolkit.brandKeywords)}
- Logo URL(s): ${compactJson(toolkit.logoUrls?.length ? toolkit.logoUrls : toolkit.logoUrl ? [toolkit.logoUrl] : [])}
- Logo visible: ${toolkit.logoVisibility !== false}
- Logo usage rules (mandatory): ${toolkit.logoUsageGuidelines || ''}
- Logo integrity policy (mandatory): Use only the approved logo asset above. Never redraw, restyle, recolor, crop, stretch, or invent a substitute wordmark. If the approved asset cannot be rendered, leave a clean logo-safe area instead of synthesizing one.
- Primary colors: ${compactJson(toolkit.primaryColors?.length ? toolkit.primaryColors : [toolkit.primaryBrandColor].filter(Boolean))}
- Secondary colors: ${compactJson(toolkit.secondaryColors?.length ? toolkit.secondaryColors : [toolkit.secondaryBrandColor].filter(Boolean))}
- Additional colors: ${compactJson(toolkit.additionalColors)}
- Fonts: ${compactJson(toolkit.fonts || { body: toolkit.fontFamily })}
- Image style: ${toolkit.imageStyleReference || ''}
- Brand images: ${compactJson(toolkit.imageAssets)}
- Website screenshot: ${toolkit.websiteScreenshotUrl || ''}
- Visual instructions for image and video (mandatory): ${toolkit.visualInstructions || ''}
- Voice type: ${toolkit.voiceType || ''}
- Custom tone guidance: ${toolkit.customToneGuidelines || ''}
- Personality traits: ${compactJson(toolkit.voicePersonalityTraits)}
- Voice dos: ${compactJson(toolkit.voiceDos)}
- Voice don'ts (mandatory): ${compactJson(toolkit.voiceDonts)}
- Voice keywords: ${compactJson(toolkit.voiceKeywords)}
- Default CTAs: ${compactJson(toolkit.defaultCtas)}
- Default hashtags: ${compactJson(toolkit.defaultHashtags)}
- Sample content: ${compactJson(toolkit.sampleContent)}
- Content pillars: ${compactJson(toolkit.contentPillars)}
- Approved formats: ${compactJson(toolkit.contentFormats)}
- Global content instructions (mandatory): ${toolkit.contentInstructions || ''}
- Audience pain points: ${compactJson(toolkit.audiencePainPoints)}
- Audience goals: ${compactJson(toolkit.audienceGoals)}
- Audience language: ${compactJson(toolkit.audienceLanguageStyle)}
- Audience triggers: ${compactJson(toolkit.audienceTriggers)}
</approved_business_and_brand_context>`;
}

function compactMediaValue(value: unknown, maxLength: number): string {
  const serialized = typeof value === 'string' ? value : compactJson(value);
  if (!serialized) return '';
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 1)}…`;
}

/**
 * Provider-safe visual subset of the authoritative context. Text templates use
 * the complete formatter above; image/video models receive the fields that can
 * affect the rendered media, kept below their 4,000-character prompt ceiling.
 */
export function formatMediaBrandContext(context: ResolvedContentBrandContext): string {
  const business = context.businessProfile;
  const toolkit = context.brandToolkit;
  const logoVisible = toolkit.logoVisibility !== false;
  const hasApprovedLogo = Boolean(toolkit.logoUrl || toolkit.logoUrls?.[0]);
  const contextBody = `<approved_media_brand_context>
- Business: ${compactMediaValue(business.companyName || business.businessName || business.name, 120)}
- Industry: ${compactMediaValue([business.industry, business.subIndustry].filter(Boolean).join(' / '), 160)}
- Business description: ${compactMediaValue(business.description, 280)}
- Value proposition and offer: ${compactMediaValue(business.valueProposition, 300)}
- Target audience: ${compactMediaValue([business.targetMarket, business.customerType].filter(Boolean).join('; '), 240)}
- Target regions: ${compactMediaValue(business.targetRegions, 140)}
- Key buyer roles: ${compactMediaValue(business.keyBuyerRoles, 180)}
- Business goals: ${compactMediaValue(business.businessGoals, 180)}
- Business brand tone: ${compactMediaValue(business.brandTone, 140)}
- Business restrictions and claim constraints (mandatory): ${compactMediaValue(business.restrictions, 220)}
- Brand: ${compactMediaValue(toolkit.name, 120)}
- Brand description: ${compactMediaValue(toolkit.description, 180)}
- Tagline: ${compactMediaValue(toolkit.tagline, 140)}
- Brand values and keywords: ${compactMediaValue({ values: toolkit.brandValues, keywords: toolkit.brandKeywords }, 220)}
- Approved colors: ${compactMediaValue({ primary: toolkit.primaryColors?.length ? toolkit.primaryColors : [toolkit.primaryBrandColor].filter(Boolean), secondary: toolkit.secondaryColors?.length ? toolkit.secondaryColors : [toolkit.secondaryBrandColor].filter(Boolean), additional: toolkit.additionalColors }, 260)}
- Typography: ${compactMediaValue(toolkit.fonts || { body: toolkit.fontFamily }, 160)}
- Image style: ${compactMediaValue(toolkit.imageStyleReference, 140)}
- Visual instructions (mandatory): ${compactMediaValue(toolkit.visualInstructions, 420)}
- Content instructions relevant to visible copy: ${compactMediaValue(toolkit.contentInstructions, 220)}`;
  const logoHandling = `
- Logo visible: ${logoVisible}
- Logo rules (mandatory): ${compactMediaValue(toolkit.logoUsageGuidelines, 260)}
- Logo handling: ${logoVisible && hasApprovedLogo ? 'the approved logo image is attached to the media-generation request as a visual asset reference. Analyze that exact asset before generation and use its visual identity together with this business profile and Brand Toolkit. Integrate it naturally and legibly into the final composition while preserving its identity and proportions.' : logoVisible ? 'no approved logo asset is available. Do not invent or synthesize a logo or wordmark.' : 'logo visibility is disabled. Do not render a logo or wordmark.'} Do not invent, substitute, recolor, distort, crop, or add competing marks. The provider output is final; no post-generation corner overlay or compositor is applied.
</approved_media_brand_context>`;
  const maxContextLength = 2700;
  const bodyBudget = Math.max(0, maxContextLength - logoHandling.length);
  return `${contextBody.slice(0, bodyBudget)}${logoHandling}`;
}

export function brandContextSnapshot(context: ResolvedContentBrandContext) {
  return {
    provenance: context.provenance,
    businessProfile: { ...context.businessProfile },
    brandToolkit: { ...context.brandToolkit },
  };
}
import { requireBusinessScope } from '../../tenancy/businessContext.js';
