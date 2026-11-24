// ─── Lead Enrichment — Shared Types ─────────────────────────────────────────────

export type EnrichmentPlatform = 'instagram' | 'facebook' | 'twitter' | 'linkedin' | 'website';

/** Sub-type for secondary/deeper scraping beyond profile-level */
export type EnrichmentSubType = 'posts' | 'company' | 'details';

export interface EnrichmentHandle {
  platform: EnrichmentPlatform;
  subType?: EnrichmentSubType; // If set, uses SECONDARY_ACTORS instead of PLATFORM_ACTORS
  identifier: string; // handle, URL, or domain
  source: string;     // where this handle was discovered (e.g. "instagram_bio", "website_footer")
}

export interface EnrichmentIterationResult {
  /** Explicit input subject, not an employer/footer link discovered later. */
  isSubject?: boolean;
  platform: EnrichmentPlatform;
  identifier: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData: any;
  extractedInfo: ExtractedInfo;
}

export interface ExtractedInfo {
  emails: string[];
  phones: string[];
  websites: string[];
  socialProfiles: {
    instagram?: string;
    facebook?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
    youtube?: string;
    [key: string]: string | undefined; // Allow dynamic keys (linkedin_company, mentions, etc.)
  };
  company?: {
    name?: string;
    domain?: string;
    industry?: string;
    size?: string;
    description?: string;
    address?: string;
  };
  person?: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    title?: string;
    bio?: string;
    location?: string;
    headline?: string;
  };
  socialStats?: {
    followersCount?: number;
    followingCount?: number;
    postsCount?: number;
    followers?: string[];
    following?: string[];
  };
}

export interface EnrichmentResult {
  success: boolean;
  iterations: number;
  totalHandlesProcessed: number;
  aggregatedData: AggregatedEnrichmentData;
  iterationLog: Array<{
    iteration: number;
    platform: EnrichmentPlatform;
    identifier: string;
    newHandlesFound: number;
    duration: number;
  }>;
  error?: string;
}

export interface AggregatedEnrichmentData {
  emails: string[];
  phones: string[];
  websites: string[];
  socialProfiles: Record<string, string>;
  company: Record<string, string | undefined>;
  person: Record<string, string | undefined>;
  socialStats: { followersCount?: number; followingCount?: number; postsCount?: number; followers?: string[]; following?: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawScrapedData: Record<string, any>;
}
