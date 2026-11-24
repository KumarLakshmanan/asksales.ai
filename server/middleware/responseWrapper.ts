import type { Request, Response, NextFunction } from 'express';
import { redactLogText } from '../utils/logRedaction.js';
import type { SocialPublishAttemptStatus } from '../models/socialPublishAttempts/schema.js';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error);
// Public DTOs must not inherit fields or execute diagnostic getters/toJSON hooks.
const own = (value: JsonRecord, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
const safeText = (value: string) => redactLogText(value);

const PUBLISH_PLATFORMS = ['instagram', 'facebook', 'youtube', 'linkedin'] as const;
type PublishPlatform = typeof PUBLISH_PLATFORMS[number];
const PUBLISH_STATUSES = ['pending', 'claimed', 'provider_succeeded', 'succeeded', 'retryable_failed', 'ambiguous', 'failed', 'cancelled', 'remote_deleted'] as const satisfies readonly SocialPublishAttemptStatus[];
type PublicPublishResult = {
  success: boolean; scheduled?: boolean; terminal?: boolean; status?: SocialPublishAttemptStatus;
  attemptId?: number; assetId?: number; postId?: string; postUrl?: string; error?: string; errorCode?: string;
};
type PublicPublishingAcknowledgement = {
  accepted?: boolean; scheduled?: boolean; partialSuccess?: boolean; platform?: PublishPlatform; platforms?: PublishPlatform[];
  results: Partial<Record<PublishPlatform, PublicPublishResult>>;
};
const publishPlatform = (value: unknown): value is PublishPlatform => PUBLISH_PLATFORMS.some(platform => platform === value);
const unsafePublishCharacters = (value: string) => Array.from(value).some(character => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127 || /\s/u.test(character);
});
function publishPlatforms(value: unknown): PublishPlatform[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > PUBLISH_PLATFORMS.length) return undefined;
  const result: PublishPlatform[] = [];
  for (let index = 0; index < value.length; index++) {
    const platform: unknown = Object.getOwnPropertyDescriptor(value, String(index))?.value;
    if (!publishPlatform(platform) || result.includes(platform)) return undefined;
    result.push(platform);
  }
  return result;
}
const PUBLISH_HOSTS: Record<PublishPlatform, readonly string[]> = {
  instagram: ['instagram.com', 'www.instagram.com'], facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'youtu.be'], linkedin: ['linkedin.com', 'www.linkedin.com'],
};
function publishPostUrl(value: unknown, platform: PublishPlatform): string | undefined {
  if (!text(value) || value.length > 2048 || unsafePublishCharacters(value) || safeText(value) !== value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !PUBLISH_HOSTS[platform].includes(url.hostname)) return undefined;
    if ([...url.searchParams.keys()].some(key => /token|key|secret|password|signature|authorization|code/i.test(key))) return undefined;
    if (url.hash) return undefined;
    return value;
  } catch { return undefined; }
}

/** A publishing receipt is a bounded public acknowledgement, even when not all
 * destinations have finished. Reviewed payloads and authority snapshots stay private. */
function publicPublishingAcknowledgement(source: JsonRecord): PublicPublishingAcknowledgement | undefined {
  const results = own(source, 'results');
  if (!record(results)) return undefined;
  const projected: PublicPublishingAcknowledgement = { results: {} };
  let count = 0;
  for (const platform of PUBLISH_PLATFORMS) {
    const entry = own(results, platform);
    if (!record(entry)) continue;
    const success = own(entry, 'success');
    if (!boolean(success)) continue;
    const result: PublicPublishResult = { success };
    for (const key of ['scheduled', 'terminal'] as const) {
      const value = own(entry, key); if (boolean(value)) result[key] = value;
    }
    const status = PUBLISH_STATUSES.find(value => value === own(entry, 'status'));
    if (status !== undefined) result.status = status;
    for (const key of ['attemptId', 'assetId'] as const) {
      const value = own(entry, key);
      if (number(value) && Number.isSafeInteger(value) && value > 0) result[key] = value;
    }
    const postId = own(entry, 'postId');
    if (text(postId) && postId.length > 0 && postId.length <= 255 && !unsafePublishCharacters(postId) && safeText(postId) === postId && safeText(postId.toLowerCase()) === postId.toLowerCase()) result.postId = postId;
    const postUrl = publishPostUrl(own(entry, 'postUrl'), platform);
    if (postUrl !== undefined) result.postUrl = postUrl;
    const error = own(entry, 'error');
    if (text(error) && error.length > 0) result.error = safeText(error).slice(0, 2000);
    const errorCode = own(entry, 'errorCode');
    if (text(errorCode) && errorCode.length <= 100 && /^[A-Z][A-Z0-9_]*$/.test(errorCode) && safeText(errorCode) === errorCode && safeText(errorCode.toLowerCase()) === errorCode.toLowerCase()) result.errorCode = errorCode;
    projected.results[platform] = result;
    count++;
  }
  if (count === 0) return undefined;
  for (const key of ['accepted', 'scheduled', 'partialSuccess'] as const) {
    const value = own(source, key); if (boolean(value)) projected[key] = value;
  }
  const platform = own(source, 'platform');
  if (publishPlatform(platform)) projected.platform = platform;
  const platforms = publishPlatforms(own(source, 'platforms'));
  if (platforms !== undefined) projected.platforms = platforms;
  return projected;
}

function copyFields(target: JsonRecord, source: JsonRecord, keys: readonly string[], valid: (value: unknown) => boolean) {
  for (const key of keys) {
    const value = own(source, key);
    if (valid(value)) target[key] = typeof value === 'string' ? safeText(value) : value;
  }
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(text) ? value.map(safeText) : undefined;
}
function validationDetails(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  if (value.every(text)) return value.map(safeText);
  return value.filter(record).map(issue => {
    const detail: JsonRecord = {};
    copyFields(detail, issue, ['field', 'message', 'code'], text);
    const path = own(issue, 'path');
    if (Array.isArray(path) && path.every(part => text(part) || number(part))) detail.path = path;
    return detail;
  }).filter(issue => Object.keys(issue).length > 0);
}
function validationErrors(value: unknown): unknown {
  if (Array.isArray(value)) return validationDetails(value);
  if (!record(value)) return undefined;
  const errors: JsonRecord = {};
  const formErrors = strings(own(value, 'formErrors'));
  if (formErrors) errors.formErrors = formErrors;
  const fieldErrors = own(value, 'fieldErrors');
  if (record(fieldErrors)) {
    const fields: JsonRecord = Object.create(null) as JsonRecord;
    for (const key of Object.keys(fieldErrors)) {
      const messages = strings(own(fieldErrors, key));
      if (messages) fields[key] = messages;
    }
    errors.fieldErrors = fields;
  }
  return Object.keys(errors).length ? errors : undefined;
}

function publicSubscription(value: unknown): unknown {
  if (!record(value)) return undefined;
  const result: JsonRecord = {};
  copyFields(result, value, ['allowed', 'canTopUp'], boolean);
  copyFields(result, value, ['reason'], text);
  const until = own(value, 'accessUntil');
  if (until === null || text(until)) result.accessUntil = until;
  return result;
}
function publicDraft(value: unknown): unknown {
  if (value === null) return null; // A cleared draft is a recovery tombstone.
  if (!record(value)) return undefined;
  const result: JsonRecord = {};
  // data is the controller-authorized user's editable JSON, not error metadata.
  if (record(own(value, 'data'))) result.data = own(value, 'data');
  copyFields(result, value, ['step', 'revision'], number);
  copyFields(result, value, ['updatedAt'], item => text(item) || item instanceof Date);
  return result;
}
function publicProfile(value: unknown): unknown {
  if (!record(value)) return undefined;
  const profile: JsonRecord = {};
  // Explicit conflict DTO. Never copy creation hashes, internal errors or a future secret column.
  const keys = [
    'id', 'userId', 'billingOrganizationId', 'version', 'name', 'profileType', 'workspaceType', 'timezone',
    'setupGoal', 'currentTools', 'companyName', 'industry', 'subIndustry', 'website', 'companySize', 'annualRevenue',
    'ownerName', 'businessName', 'businessCategory', 'establishedYear', 'businessHours', 'phone', 'email',
    'address', 'city', 'state', 'country', 'postalCode', 'description', 'targetMarket', 'valueProposition',
    'linkedinUrl', 'twitterUrl', 'facebookUrl', 'instagramUrl', 'youtubeUrl', 'platforms', 'contentFormats',
    'visualStyle', 'referenceAccounts', 'businessGoals', 'targetRegions', 'customerType', 'keyBuyerRoles',
    'preferredChannels', 'brandTone', 'approvalMode', 'restrictions', 'isDefault', 'isApproved',
    'approvedBy', 'categoryId', 'subcategoryId', 'legacyCompanyProfileId',
  ];
  // These are authorized recovery data, so preserve their original values (including contact fields).
  for (const key of keys) {
    const item = own(value, key);
    if (item === null || text(item) || number(item) || boolean(item)) profile[key] = item;
  }
  for (const key of ['approvedAt', 'archivedAt', 'createdAt', 'updatedAt']) {
    const item = own(value, key);
    if (item === null || text(item) || item instanceof Date) profile[key] = item;
  }
  for (const key of ['applicationUses', 'websiteAnalysis', 'crmConfiguration']) {
    const item = own(value, key);
    if (item === null || record(item) || Array.isArray(item)) profile[key] = item;
  }
  return profile;
}

/** Error envelope contract. Add public recovery fields deliberately with a regression test;
 * never spread a controller error, provider payload, Error instance, cause or SQL diagnostic. */
function publicError(body: unknown, statusCode: number): JsonRecord {
  const source = record(body) ? body : {};
  const message = [own(source, 'error'), own(source, 'message')].find(value => text(value) && value.length > 0);
  const result: JsonRecord = { success: false, error: text(message) ? safeText(message) : 'An error occurred' };
  const code = own(source, 'code');
  // Established Conversation HTTP/WS compatibility code; no general lowercase/provider-code passthrough.
  if (text(code) && (/^[A-Z][A-Z0-9_]{0,100}$/.test(code) || code === 'request_conflict')) result.code = code;
  copyFields(result, source, [
    'message', 'field', 'resource', 'module', 'status', 'activeAgentType',
    'jobId', 'partialExternalCampaignId', 'outcome', 'privacyOutcome',
  ], text);
  const publishing = publicPublishingAcknowledgement(source);
  const platform = own(source, 'platform');
  const publishingCandidate = publishing !== undefined || ['accepted', 'scheduled', 'partialSuccess'].some(key => boolean(own(source, key)));
  if (text(platform) && (!publishingCandidate || publishPlatform(platform))) result.platform = safeText(platform);
  if (publishing !== undefined) {
    result.results = publishing.results;
    for (const key of ['accepted', 'scheduled', 'partialSuccess', 'platforms'] as const) {
      if (publishing[key] !== undefined) result[key] = publishing[key];
    }
    // An accepted/partial 2xx acknowledgement is not an invented generic failure.
    if (statusCode >= 200 && statusCode < 300 && message === undefined && (publishing.accepted || publishing.scheduled || publishing.partialSuccess)) delete result.error;
  }
  copyFields(result, source, [
    'current', 'requestedIncrease', 'limit', 'organizationId', 'importId', 'row', 'balance', 'retryAfter',
    'assetId', 'campaignId', 'providerStatus', 'providerCode', 'providerSubcode', 'metricsUpdated',
  ], number);
  for (const key of ['providerCode', 'providerSubcode']) if (own(source, key) === null) result[key] = null;
  copyFields(result, source, [
    'retryable', 'maintenance', 'requiresConnection', 'reconnectRequired', 'connected', 'needsConfig',
    'ambiguous', 'persisted', 'done', 'providerDone', 'inProgress', 'manualReviewRequired', 'sideEffectsSuppressed',
  ], boolean);
  for (const key of ['modules', 'missingRequiredFields', 'mappingErrors', 'allowedFields', 'violations', 'unresolvedTokens', 'supportedFormats']) {
    const value = strings(own(source, key));
    if (value) result[key] = value;
  }
  for (const key of ['details', 'issues']) {
    const value = validationErrors(own(source, key));
    if (value !== undefined) result[key] = value;
  }
  const errors = validationErrors(own(source, 'errors'));
  if (errors !== undefined) result.errors = errors;
  if (code === 'SUBSCRIPTION_REQUIRED') {
    const subscription = publicSubscription(own(source, 'subscription'));
    if (subscription !== undefined) result.subscription = subscription;
  }
  if (code === 'SETUP_DRAFT_CONFLICT') {
    const draft = publicDraft(own(source, 'draft'));
    if (draft !== undefined) result.draft = draft;
  }
  if (code === 'PROFILE_VERSION_CONFLICT') {
    const profile = publicProfile(own(source, 'profile'));
    if (profile !== undefined) result.profile = profile;
  }
  return result;
}

/**
 * Middleware that standardizes all API JSON responses.
 *
 * Success:  { success: true, data: T } or { success: true, message: string }
 * List:     { success: true, data: T[], total?, page?, limit? }
 * Error:    { success: false, error: string, ...explicit public recovery fields }
 *
 * Successful controller-owned payloads retain their existing shapes. This is an
 * error-envelope boundary, not a replacement for controller authorization or DTOs.
 * Pass-through: successful responses that already have a boolean `success` field,
 * non-object bodies, and non-JSON responses (res.send, SSE, files).
 */
export function responseWrapper(_req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json;

  res.json = function (body: unknown) {
    // Non-object JSON values retain their legacy wire representation.
    if (body === null || body === undefined || typeof body !== 'object') {
      return originalJson.call(this, body);
    }
    // Normalize before legacy success pass-through. A pre-standardized error or
    // contradictory success flag must not bypass the public field projection.
    if (this.statusCode >= 400 || (record(body) && own(body, 'success') === false)) {
      return originalJson.call(this, publicError(body, this.statusCode));
    }

    // Already standardized – has a boolean 'success' field
    if (record(body) && own(body, 'success') === true) {
      return originalJson.call(this, body);
    }

    // Array → wrap in data
    if (Array.isArray(body)) {
      return originalJson.call(this, { success: true, data: body });
    }

    // Object with existing 'data' field → add success flag and spread meta
    if ('data' in body) {
      return originalJson.call(this, { success: true, ...body });
    }

    // Object with only 'message' → success message response
    if ('message' in body && Object.keys(body).length === 1) {
      return originalJson.call(this, { success: true, message: body.message });
    }

    // Everything else → wrap in data
    return originalJson.call(this, { success: true, data: body });
  };

  next();
}
