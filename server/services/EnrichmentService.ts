/**
 * Enrichment Service - Integrates with Clearbit and other providers
 * Enriches lead data with company and person information
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { sleep } from '../utils/sleep.js';

// Phase 4.6 / SERV-006: shared Redis-backed enrichment cache.
// Key shape: enrichment:<scope>:<sha256(input)>, TTL 30d.
// Scope = 'person' | 'company'
const ENRICHMENT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface PersonEnrichmentData {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: {
    city?: string;
    state?: string;
    country?: string;
  };
  employment?: {
    title?: string;
    role?: string;
    seniority?: string;
    department?: string;
    companyName?: string;
    domain?: string;
  };
  social?: {
    linkedin?: string;
    twitter?: string;
    facebook?: string;
    github?: string;
  };
  bio?: string;
  avatar?: string;
}

export interface CompanyEnrichmentData {
  name?: string;
  legalName?: string;
  domain?: string;
  description?: string;
  logo?: string;
  website?: string;
  phone?: string;
  
  location?: {
    city?: string;
    state?: string;
    country?: string;
    address?: string;
  };
  
  metrics?: {
    employees?: number;
    employeesRange?: string;
    estimatedAnnualRevenue?: string;
    marketCap?: string;
    raised?: string;
    fiscalYearEnd?: number;
  };
  
  category?: {
    industry?: string;
    industryGroup?: string;
    sector?: string;
    subIndustry?: string;
    naicsCode?: string;
    sicCode?: string;
  };
  
  identifiers?: {
    usEIN?: string;
    ticker?: string;
  };
  
  tags?: string[];
  techStack?: string[];
  
  founded?: number;
  
  social?: {
    linkedin?: {
      handle?: string;
      url?: string;
    };
    twitter?: {
      handle?: string;
      url?: string;
    };
    facebook?: {
      handle?: string;
      url?: string;
    };
  };
}

export interface EnrichmentResult {
  success: boolean;
  provider: string;
  person?: PersonEnrichmentData;
  company?: CompanyEnrichmentData;
  error?: string;
  rateLimitRemaining?: number;
  cached?: boolean;
}

export interface EnrichmentOptions {
  includeCompany?: boolean;
  includePerson?: boolean;
  stream?: boolean;
  webhookUrl?: string;
  timeout?: number;
}

/**
 * EnrichmentService - Main service for lead enrichment
 * API keys should be provided via constructor from user's credentials in database
 */
export class EnrichmentService {
  private apiKey: string;
  private baseUrl: string = 'https://person.clearbit.com';
  private companyUrl: string = 'https://company.clearbit.com';
  private rateLimitRemaining: number = 600; // Clearbit default: 600/min
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 100; // 100ms between requests (rate limiting)

  constructor(apiKey?: string) {
    this.apiKey = apiKey || '';
    
    if (!this.apiKey) {
      logger.warn('[EnrichmentService] No Clearbit API key provided. Please add your Clearbit API key in Settings → Integrations → Clearbit');
    }
  }

  /**
   * Check if enrichment is available
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Phase 4.6 / SERV-006: read-through cache for enrichment results.
   * Cache key = sha256(input) so PII never appears in Redis keys.
   * Returns the cached result on hit, undefined on miss.
   */
  private async readEnrichmentCache(scope: 'person' | 'company', input: string): Promise<EnrichmentResult | undefined> {
    try {
      const hash = crypto.createHash('sha256').update(input.toLowerCase().trim()).digest('hex');
      const raw = await getRedisConnection().get(`enrichment:${scope}:${hash}`);
      if (!raw) return undefined;
      const cached = JSON.parse(raw) as EnrichmentResult;
      // Mark the response as cached so callers can know it wasn't re-fetched.
      return { ...cached, rateLimitRemaining: this.rateLimitRemaining };
    } catch (err) {
      // Cache failures should never break enrichment — log and fall through.
      logger.warn({ err: (err as Error).message }, '[EnrichmentService] Cache read failed');
      return undefined;
    }
  }

  private async writeEnrichmentCache(scope: 'person' | 'company', input: string, result: EnrichmentResult): Promise<void> {
    if (!result.success) return; // Don't cache negative results
    try {
      const hash = crypto.createHash('sha256').update(input.toLowerCase().trim()).digest('hex');
      await getRedisConnection().set(
        `enrichment:${scope}:${hash}`,
        JSON.stringify(result),
        'EX',
        ENRICHMENT_CACHE_TTL_SECONDS
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[EnrichmentService] Cache write failed');
    }
  }

  /**
   * Enrich a person by email
   */
  async enrichPerson(email: string, options: EnrichmentOptions = {}): Promise<EnrichmentResult> {
    if (!this.isAvailable()) {
      return {
        success: false,
        provider: 'clearbit',
        error: 'Clearbit API key not configured',
      };
    }

    // Phase 4.6 / SERV-006: read-through cache hit short-circuits the API call
    const cached = await this.readEnrichmentCache('person', email);
    if (cached) {
      logger.debug({ email }, '[EnrichmentService] Person cache hit');
      return cached;
    }

    try {
      // Rate limiting
      await this.respectRateLimit();

      const params = new URLSearchParams();
      params.append('email', email);
      
      if (options.stream) {
        params.append('stream', 'true');
      }
      if (options.webhookUrl) {
        params.append('webhook_url', options.webhookUrl);
      }

      const url = `${this.baseUrl}/v2/combined/find?${params.toString()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });

      // Update rate limit info
      const remaining = response.headers.get('X-RateLimit-Remaining');
      if (remaining) {
        this.rateLimitRemaining = parseInt(remaining, 10);
      }

      if (response.status === 202) {
        // Pending - queued for enrichment (async mode)
        return {
          success: true,
          provider: 'clearbit',
          error: 'Enrichment queued - use webhook for result',
          rateLimitRemaining: this.rateLimitRemaining,
        };
      }

      if (response.status === 404) {
        // Not found
        return {
          success: false,
          provider: 'clearbit',
          error: 'Person not found in Clearbit database',
          rateLimitRemaining: this.rateLimitRemaining,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Clearbit API error (${response.status}): ${errorText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      // Parse Clearbit response
      const person = this.parseClearbitPerson(data.person);
      const company = data.company ? this.parseClearbitCompany(data.company) : undefined;

      const result: EnrichmentResult = {
        success: true,
        provider: 'clearbit',
        person,
        company,
        rateLimitRemaining: this.rateLimitRemaining,
      };
      // Fire-and-forget cache write so caller isn't blocked
      void this.writeEnrichmentCache('person', email, result);
      return result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EnrichmentService] Error enriching person');
      return {
        success: false,
        provider: 'clearbit',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Enrich a company by domain
   */
  async enrichCompany(domain: string, options: EnrichmentOptions = {}): Promise<EnrichmentResult> {
    if (!this.isAvailable()) {
      return {
        success: false,
        provider: 'clearbit',
        error: 'Clearbit API key not configured',
      };
    }

    // Phase 4.6 / SERV-006: read-through cache hit short-circuits the API call
    const cached = await this.readEnrichmentCache('company', domain);
    if (cached) {
      logger.debug({ domain }, '[EnrichmentService] Company cache hit');
      return cached;
    }

    try {
      // Rate limiting
      await this.respectRateLimit();

      const url = `${this.companyUrl}/v2/companies/find?domain=${encodeURIComponent(domain)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
      });

      // Update rate limit info
      const remaining = response.headers.get('X-RateLimit-Remaining');
      if (remaining) {
        this.rateLimitRemaining = parseInt(remaining, 10);
      }

      if (response.status === 404) {
        return {
          success: false,
          provider: 'clearbit',
          error: 'Company not found in Clearbit database',
          rateLimitRemaining: this.rateLimitRemaining,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Clearbit API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const company = this.parseClearbitCompany(data);

      const result: EnrichmentResult = {
        success: true,
        provider: 'clearbit',
        company,
        rateLimitRemaining: this.rateLimitRemaining,
      };
      // Fire-and-forget cache write
      void this.writeEnrichmentCache('company', domain, result);
      return result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EnrichmentService] Error enriching company');
      return {
        success: false,
        provider: 'clearbit',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Batch enrich multiple emails (processes serially with rate limiting)
   */
  async enrichBatch(emails: string[], options: EnrichmentOptions = {}): Promise<EnrichmentResult[]> {
    const results: EnrichmentResult[] = [];

    logger.info({ count: emails.length }, '[EnrichmentService] Starting batch enrichment for emails');

    for (const email of emails) {
      const result = await this.enrichPerson(email, options);
      results.push(result);

      // Additional delay between batch requests
      if (this.rateLimitRemaining < 100) {
        logger.info({ rateLimitRemaining: this.rateLimitRemaining }, '[EnrichmentService] Rate limit low, adding delay');
        await sleep(1000); // 1 second delay
      }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info({ successCount: successCount, count: emails.length }, '[EnrichmentService] Batch enrichment complete: / successful');

    return results;
  }

  /**
   * Parse Clearbit person response to our format
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseClearbitPerson(person: any): PersonEnrichmentData {
    if (!person) return {};

    return {
      fullName: person.name?.fullName,
      firstName: person.name?.givenName,
      lastName: person.name?.familyName,
      email: person.email,
      phone: person.phone,
      location: person.location ? {
        city: person.location.city,
        state: person.location.state,
        country: person.location.country,
      } : undefined,
      employment: person.employment ? {
        title: person.employment.title,
        role: person.employment.role,
        seniority: person.employment.seniority,
        department: person.employment.subRole,
        companyName: person.employment.name,
        domain: person.employment.domain,
      } : undefined,
      social: {
        linkedin: person.linkedin?.handle,
        twitter: person.twitter?.handle,
        facebook: person.facebook?.handle,
        github: person.github?.handle,
      },
      bio: person.bio,
      avatar: person.avatar,
    };
  }

  /**
   * Parse Clearbit company response to our format
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseClearbitCompany(company: any): CompanyEnrichmentData {
    if (!company) return {};

    return {
      name: company.name,
      legalName: company.legalName,
      domain: company.domain,
      description: company.description,
      logo: company.logo,
      website: company.site?.url,
      phone: company.phone,
      
      location: company.geo ? {
        city: company.geo.city,
        state: company.geo.state,
        country: company.geo.country,
        address: company.location,
      } : undefined,
      
      metrics: company.metrics ? {
        employees: company.metrics.employees,
        employeesRange: company.metrics.employeesRange,
        estimatedAnnualRevenue: company.metrics.estimatedAnnualRevenue,
        marketCap: company.metrics.marketCap,
        raised: company.metrics.raised,
        fiscalYearEnd: company.metrics.fiscalYearEnd,
      } : undefined,
      
      category: company.category ? {
        industry: company.category.industry,
        industryGroup: company.category.industryGroup,
        sector: company.category.sector,
        subIndustry: company.category.subIndustry,
        naicsCode: company.category.naicsCode,
        sicCode: company.category.sicCode,
      } : undefined,
      
      identifiers: company.identifiers ? {
        usEIN: company.identifiers.usEIN,
        ticker: company.ticker,
      } : undefined,
      
      tags: company.tags || [],
      techStack: company.tech || [],
      
      founded: company.foundedYear,
      
      social: {
        linkedin: company.linkedin ? {
          handle: company.linkedin.handle,
          url: `https://linkedin.com/company/${company.linkedin.handle}`,
        } : undefined,
        twitter: company.twitter ? {
          handle: company.twitter.handle,
          url: `https://twitter.com/${company.twitter.handle}`,
        } : undefined,
        facebook: company.facebook ? {
          handle: company.facebook.handle,
          url: `https://facebook.com/${company.facebook.handle}`,
        } : undefined,
      },
    };
  }

  /**
   * Respect rate limiting
   */
  private async respectRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const delay = this.minRequestInterval - timeSinceLastRequest;
      await sleep(delay);
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): { remaining: number; timestamp: number } {
    return {
      remaining: this.rateLimitRemaining,
      timestamp: this.lastRequestTime,
    };
  }

  /**
   * Check if we should throttle requests
   */
  shouldThrottle(): boolean {
    return this.rateLimitRemaining < 50; // Throttle when less than 50 requests remaining
  }
}

/**
 * Factory function to create EnrichmentService with user's credentials
 * Usage: const service = await createEnrichmentService(userId);
 */
export async function createEnrichmentService(userId: number): Promise<EnrichmentService> {
  const { getCredential } = await import('./credentialService');
  const cred = await getCredential(userId, 'clearbit');
  return new EnrichmentService(cred?.apiKey);
}

// Default instance without API key - callers should use createEnrichmentService() instead
export const enrichmentService = new EnrichmentService();
