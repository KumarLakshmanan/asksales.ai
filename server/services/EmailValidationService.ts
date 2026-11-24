/**
 * Email Validation Service - Integrates with ZeroBounce
 * Validates email deliverability and quality
 * Supports automatic API key fallback on rate limit/quota errors
 * 
 * NOTE: Uses admin API credentials from admin_api_credentials table.
 * All users share these system-wide credentials.
 */

import {
  isRateLimitError,
} from './apiKeyFallbackService';
import { logger } from '../utils/logger.js';
import { createZerobounceUsage } from '../models/zerobounceUsages/functions';
import { getAdminZerobounceKey, updateAdminCredentialUsage, markAdminCredentialAsInactive, getNextAdminCredential } from './adminCredentialsService';
import { sleep } from '../utils/sleep.js';

export type EmailStatus = 
  | 'valid' 
  | 'invalid' 
  | 'catch-all' 
  | 'unknown' 
  | 'spamtrap' 
  | 'abuse' 
  | 'do_not_mail';

export type EmailSubStatus = 
  | 'antispam_system'
  | 'greylisted'
  | 'mail_server_temporary_error'
  | 'forcible_disconnect'
  | 'mail_server_did_not_respond'
  | 'timeout_exceeded'
  | 'failed_smtp_connection'
  | 'mailbox_quota_exceeded'
  | 'exception_occurred'
  | 'possible_trap'
  | 'role_based'
  | 'global_suppression'
  | 'mailbox_not_found'
  | 'no_dns_entries'
  | 'failed_syntax_check'
  | 'possible_typo'
  | 'unroutable_ip_address'
  | 'leading_period_removed'
  | 'does_not_accept_mail'
  | 'alias_address'
  | 'role_based_catch_all'
  | 'disposable'
  | 'toxic';

export interface EmailValidationResult {
  success: boolean;
  email: string;
  status: EmailStatus;
  subStatus?: EmailSubStatus;
  freeEmail: boolean;
  disposableEmail: boolean;
  roleAccount: boolean;
  didYouMean?: string; // Suggested correction
  score: number; // 0-10 deliverability score
  mxFound: boolean;
  mxRecord?: string;
  smtpProvider?: string;
  firstname?: string;
  lastname?: string;
  gender?: string;
  country?: string;
  region?: string;
  city?: string;
  zipcode?: string;
  processedAt: Date;
  error?: string;
  creditsRemaining?: number;
}

export interface BulkValidationJob {
  fileId: string;
  fileName: string;
  uploadedAt: Date;
  totalRecords: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  completedAt?: Date;
  downloadUrl?: string;
}

/**
 * EmailValidationService - Main service for email validation
 * Supports automatic API key fallback on rate limit/quota errors
 * Uses admin-configured API keys from admin_api_credentials table
 */
export class EmailValidationService {
  private apiKey: string;
  private baseUrl: string = 'https://api.zerobounce.net/v2';
  private bulkUrl: string = 'https://bulkapi.zerobounce.net/v2';
  private creditsRemaining?: number;
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 100; // Rate limiting
  private userId?: number;
  private adminCredentialId?: number;

  constructor(apiKey?: string, userId?: number) {
    this.apiKey = apiKey || '';
    this.userId = userId;
    // No warning needed - service will try to get admin credentials lazily on first use via getApiKeyForUser()
  }

  /**
   * Create service using admin credentials
   */
  static async createWithAdminCredentials(userId?: number): Promise<EmailValidationService> {
    const adminCred = await getAdminZerobounceKey();
    
    if (!adminCred) {
      logger.warn('[EmailValidationService] No admin ZeroBounce credential configured');
      return new EmailValidationService(undefined, userId);
    }
    
    logger.info(`[EmailValidationService] Creating service with admin credential ID: ${adminCred.id}`);
    
    // Update last used timestamp
    await updateAdminCredentialUsage(adminCred.id);
    
    const service = new EmailValidationService(adminCred.apiKey, userId);
    service.adminCredentialId = adminCred.id;
    return service;
  }

  /**
   * Check if ZeroBounce service is available (has admin credentials)
   */
  static async isAvailableGlobal(): Promise<boolean> {
    const adminCred = await getAdminZerobounceKey();
    return adminCred !== null;
  }

  /**
   * Get API key from admin credentials or fallback
   * Tracks credential info for fallback handling
   */
  private async getApiKeyForUser(): Promise<string> {
    if (!this.apiKey && !this.adminCredentialId) {
      const adminCred = await getAdminZerobounceKey();
      if (adminCred) {
        logger.info('[EmailValidationService] Using ZeroBounce API key from admin credentials');
        this.apiKey = adminCred.apiKey;
        this.adminCredentialId = adminCred.id;
        await updateAdminCredentialUsage(adminCred.id);
        return adminCred.apiKey;
      }
    }
    
    if (this.apiKey) {
      return this.apiKey;
    }
    
    throw new Error('ZeroBounce API key not configured. Please ask an administrator to add the API key in Admin > Integrations.');
  }

  /**
   * Handle rate limit error and try to get next available admin key
   */
  private async handleRateLimitAndGetNextKey(): Promise<string | null> {
    if (this.adminCredentialId) {
      await markAdminCredentialAsInactive(this.adminCredentialId, 'rate_limit');
      
      const nextAdmin = await getNextAdminCredential('zerobounce', this.adminCredentialId);
      if (nextAdmin) {
        logger.info(`[EmailValidationService] Falling back to next admin ZeroBounce key (ID: ${nextAdmin.id})`);
        this.apiKey = nextAdmin.apiKey;
        this.adminCredentialId = nextAdmin.id;
        await updateAdminCredentialUsage(nextAdmin.id);
        return nextAdmin.apiKey;
      }
    }
    
    return null;
  }

  /**
   * Check if validation is available.
   * Always returns true since the service will attempt to fetch admin credentials lazily
   * via getApiKeyForUser() on first use (similar to how OpenAI admin keys work).
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Validate a single email address with automatic fallback on rate limits
   */
  async validateEmail(email: string, ipAddress?: string): Promise<EmailValidationResult> {
    if (!this.isAvailable()) {
      return this.createDisabledResult(email);
    }

    let apiKey: string;
    try {
      apiKey = await this.getApiKeyForUser();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return this.createDisabledResult(email);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.respectRateLimit();

        const params = new URLSearchParams({
          api_key: apiKey,
          email: email,
        });

        if (ipAddress) {
          params.append('ip_address', ipAddress);
        }

        const url = `${this.baseUrl}/validate?${params.toString()}`;

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`ZeroBounce API error (${response.status}): ${errorText}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error as any).status = response.status;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error as any).statusCode = response.status;
          throw error;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await response.json();

        // Check for API errors
        if (data.error) {
          const error = new Error(data.error);
          // Check if error message indicates rate limit
          if (isRateLimitError(error)) {
            throw error;
          }
          throw error;
        }

        // Parse response
        const result = this.parseValidationResponse(data);
        
        // Track usage after successful validation
        await this.trackUsage(
          'single_validation',
          1,
          result.status === 'valid' ? 1 : 0,
          result.status === 'invalid' ? 1 : 0,
          result.status === 'catch-all' ? 1 : 0,
          result.status === 'unknown' ? 1 : 0,
          true
        );
        
        return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        logger.error({ err: error }, '[EmailValidationService] Error validating email:');

        // Check if rate limit error and try fallback
        if (isRateLimitError(error)) {
          logger.warn(`[EmailValidationService] Rate limit on attempt ${attempt + 1}, trying fallback...`);
          const nextKey = await this.handleRateLimitAndGetNextKey();
          
          if (nextKey) {
            apiKey = nextKey;
            continue; // Retry with new key
          }
          
          // No more keys available
          return {
            success: false,
            email,
            status: 'unknown',
            freeEmail: false,
            disposableEmail: false,
            roleAccount: false,
            score: 0,
            mxFound: false,
            processedAt: new Date(),
            error: 'All ZeroBounce API keys have hit rate limits. Please add more API keys or wait for rate limits to reset.',
          };
        }
        
        // Not a rate limit error, return error result
        return {
          success: false,
          email,
          status: 'unknown',
          freeEmail: false,
          disposableEmail: false,
          roleAccount: false,
          score: 0,
          mxFound: false,
          processedAt: new Date(),
          error: lastError.message || 'Unknown error',
        };
      }
    }

    return {
      success: false,
      email,
      status: 'unknown',
      freeEmail: false,
      disposableEmail: false,
      roleAccount: false,
      score: 0,
      mxFound: false,
      processedAt: new Date(),
      error: lastError?.message || 'Max retries reached',
    };
  }

  /**
   * Validate multiple emails (processes serially)
   */
  async validateBatch(emails: string[]): Promise<EmailValidationResult[]> {
    logger.info(`[EmailValidationService] Starting batch validation for ${emails.length} emails`);

    const results: EmailValidationResult[] = [];

    for (const email of emails) {
      const result = await this.validateEmail(email);
      results.push(result);

      // Check credits and throttle if low
      if (this.creditsRemaining !== undefined && this.creditsRemaining < 100) {
        logger.warn(`[EmailValidationService] Credits low: ${this.creditsRemaining}`);
        await sleep(500); // Extra delay
      }
    }

    const validCount = results.filter(r => r.status === 'valid').length;
    logger.info(`[EmailValidationService] Batch validation complete: ${validCount}/${emails.length} valid`);

    return results;
  }

  /**
   * Get account credits remaining
   */
  async getCredits(): Promise<number | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const url = `${this.baseUrl}/getcredits?api_key=${this.apiKey}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch credits: ${response.status}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();
      this.creditsRemaining = parseInt(data.Credits, 10);

      logger.info(`[EmailValidationService] Credits remaining: ${this.creditsRemaining}`);
      return this.creditsRemaining;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailValidationService] Error fetching credits:');
      return null;
    }
  }

  /**
   * Submit bulk validation file (for large batches >10k)
   */
  async submitBulkFile(fileBuffer: Buffer, fileName: string): Promise<BulkValidationJob | null> {
    if (!this.isAvailable()) {
      logger.error('[EmailValidationService] Bulk validation unavailable without API key');
      return null;
    }

    try {
      const url = `${this.bulkUrl}/sendfile`;

      const formData = new FormData();
      formData.append('api_key', this.apiKey);
      formData.append('email_address_column', '1'); // Column containing email
      formData.append('file', new Blob([fileBuffer]), fileName);

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bulk upload failed (${response.status}): ${errorText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Bulk upload failed');
      }

      logger.info(`[EmailValidationService] Bulk file submitted: ${data.file_id}`);

      return {
        fileId: data.file_id,
        fileName: fileName,
        uploadedAt: new Date(),
        totalRecords: 0, // Will be updated when checking status
        status: 'queued',
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailValidationService] Error submitting bulk file:');
      return null;
    }
  }

  /**
   * Check bulk validation job status
   */
  async checkBulkStatus(fileId: string): Promise<BulkValidationJob | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const url = `${this.bulkUrl}/filestatus?api_key=${this.apiKey}&file_id=${fileId}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to check status: ${response.status}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      const status = data.file_status.toLowerCase();
      
      return {
        fileId,
        fileName: data.file_name || '',
        uploadedAt: new Date(data.upload_date),
        totalRecords: parseInt(data.total_records, 10) || 0,
        status: this.mapBulkStatus(status),
        completedAt: data.complete_date ? new Date(data.complete_date) : undefined,
        downloadUrl: data.return_url,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailValidationService] Error checking bulk status:');
      return null;
    }
  }

  /**
   * Parse ZeroBounce validation response
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseValidationResponse(data: any): EmailValidationResult {
    const status = data.status.toLowerCase() as EmailStatus;
    const score = this.calculateScore(status, data);

    return {
      success: true,
      email: data.address,
      status,
      subStatus: data.sub_status,
      freeEmail: data.free_email || false,
      disposableEmail: data.disposable || false,
      roleAccount: data.role_based || false,
      didYouMean: data.did_you_mean || undefined,
      score,
      mxFound: data.mx_found === 'true',
      mxRecord: data.mx_record,
      smtpProvider: data.smtp_provider,
      firstname: data.firstname,
      lastname: data.lastname,
      gender: data.gender,
      country: data.country,
      region: data.region,
      city: data.city,
      zipcode: data.zipcode,
      processedAt: new Date(data.processed_at),
      creditsRemaining: this.creditsRemaining,
    };
  }

  /**
   * Calculate deliverability score (0-10)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private calculateScore(status: EmailStatus, data: any): number {
    // Base score by status
    let score = 0;

    switch (status) {
      case 'valid':
        score = 10;
        break;
      case 'catch-all':
        score = 6;
        break;
      case 'unknown':
        score = 3;
        break;
      case 'invalid':
      case 'spamtrap':
      case 'abuse':
      case 'do_not_mail':
        score = 0;
        break;
    }

    // Adjust for role-based, free, or disposable
    if (data.role_based) score = Math.max(0, score - 2);
    if (data.disposable) score = 0;
    if (data.free_email && score > 0) score = Math.max(5, score - 1);

    return score;
  }

  /**
   * Map bulk status strings
   */
  private mapBulkStatus(status: string): BulkValidationJob['status'] {
    switch (status) {
      case 'complete':
        return 'completed';
      case 'processing':
        return 'processing';
      case 'failed':
        return 'failed';
      default:
        return 'queued';
    }
  }

  /**
   * Create a disabled result when API key is missing
   */
  private createDisabledResult(email: string): EmailValidationResult {
    return {
      success: false,
      email,
      status: 'unknown',
      freeEmail: false,
      disposableEmail: false,
      roleAccount: false,
      score: 5, // Neutral score
      mxFound: false,
      processedAt: new Date(),
      error: 'ZeroBounce API key not configured',
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
   * Track ZeroBounce API usage
   */
  private async trackUsage(
    operationType: string,
    emailsValidated: number,
    validEmails: number,
    invalidEmails: number,
    catchAllEmails: number,
    unknownEmails: number,
    success: boolean,
    errorMessage?: string
  ): Promise<void> {
    try {
      // Use admin-configured fixed credits per email validation
      const { getZerobounceCreditsPerEmail } = await import('../models/apiPricing/functions.js');
      const creditsPerEmail = await getZerobounceCreditsPerEmail();
      const creditsUsed = Math.round(emailsValidated * creditsPerEmail);
      const costCents = emailsValidated * 0.7; // Still log approximate USD cost for reference
      const {newUsageContext,withUsageContext}=await import('./insights/UsageContext.js');
      const {getRechargeRate}=await import('../models/creditPricing/functions.js');
      const {getUsdToInrRate}=await import('../utils/currency.js');
      const usageContext=newUsageContext({provider:'zerobounce',model:'email_validation',process:'leads'});
      usageContext.pricing={version:1,capturedAt:new Date().toISOString(),source:'fixed',sourceReference:'admin_zerobounce_credits_per_email',
        provider:'zerobounce',model:'email_validation',providerCostUsd:(costCents/100).toFixed(10),
        usdToInr:getUsdToInrRate(),creditsPerInr:await getRechargeRate(),minimumCredits:0,rounding:'round_whole'};
      
      await withUsageContext(usageContext, async()=>{
      await createZerobounceUsage({
        userId: this.userId ?? null,
        operationType,
        emailsValidated,
        validEmails,
        invalidEmails,
        catchAllEmails,
        unknownEmails,
        creditsUsed,
        costCents: String(costCents),
        service: 'email_validation',
        purpose: 'outreach_validation',
        status: success ? 'success' : 'error',
        errorMessage,
      });

      // Deduct fixed credits for ZeroBounce (admin-configured)
      if (this.userId && emailsValidated > 0) {
        const totalCredits = creditsUsed;
        if (totalCredits > 0) {
          const { creditService } = await import('./CreditService.js');
          const deduction=await creditService.deductForEvent({
            userId: this.userId,
            eventKey: 'api_zerobounce',
            description: `Email validation (${emailsValidated} emails) - ${creditsPerEmail} credits/email`,
            service: 'EmailValidationService',
            apiProvider: 'zerobounce',
            apiCostCents: costCents,
            overrideAmount: totalCredits,
            // The validation already ran at the provider: bill it in full.
            allowOverdraft: true,
            metadata: {
              emailsValidated,
              creditsPerEmail,
              totalCredits,
            },
          });
          if(!deduction.success)throw new Error(deduction.error||'Email validation charge was not recorded.');
          logger.info({ userId: this.userId, emailsValidated, creditsPerEmail, totalCredits }, '[EmailValidationService] Fixed credits deducted for validation');
        }
      }
      });
    } catch (err) {
      logger.error({ err: err }, '[EmailValidationService] Failed to track usage:');
      // Don't throw - usage tracking failure shouldn't break validation
    }
  }

  /**
   * Check if email passes quality threshold
   */
  isHighQuality(result: EmailValidationResult): boolean {
    return (
      result.status === 'valid' &&
      !result.disposableEmail &&
      !result.roleAccount &&
      result.score >= 8
    );
  }

  /**
   * Check if email is safe to send
   */
  isSafeToSend(result: EmailValidationResult): boolean {
    const unsafeStatuses: string[] = ['spamtrap', 'abuse', 'do_not_mail', 'invalid', 'unknown'];
    return (
      (result.status === 'valid' || result.status === 'catch-all') &&
      !result.disposableEmail &&
      !unsafeStatuses.includes(result.status) &&
      result.score >= 5
    );
  }
}

/**
 * Get a properly initialized EmailValidationService with admin credentials
 * Use this when you need guaranteed admin credentials instead of lazy loading
 */
export async function getEmailValidationService(userId?: number): Promise<EmailValidationService> {
  return EmailValidationService.createWithAdminCredentials(userId);
}
