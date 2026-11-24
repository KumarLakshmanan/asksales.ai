import { refreshChannelCredential } from '../ChannelCredentialRefreshService.js';
/**
 * YouTube publishing through the officially supported YouTube Data API v3.
 *
 * Community posts deliberately are not implemented: the public Data API does
 * not expose a Community Posts write resource. Keeping that limitation here
 * prevents callers from receiving a false successful publish result.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import { youtubeAnalyticsSnapshotsTable } from '../../models/youtubeAnalyticsSnapshots/schema.js';
import { getActiveAdminCredential } from '../../models/adminApiCredentials/functions.js';
import { logger } from '../../utils/logger.js';
import { fetchPublicHttpUrl, readResponseBuffer } from '../../utils/safeRemoteFetch.js';
import type { YouTubePublishingOptions } from '../../utils/youtubePublishingOptions.js';
import { decryptValue } from '../SecretsManager.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type YouTubePostType = 'video' | 'short';
export type YouTubeRequestedPostType = YouTubePostType | 'shorts' | 'community_post';

export interface YouTubeVideoMetadata {
  /** Duration supplied by trusted media processing, in seconds. */
  durationSeconds?: number;
  /** Encoded dimensions supplied by trusted media processing. */
  width?: number;
  height?: number;
}

export interface YouTubePublishInput {
  videoUrl?: string;
  title: string;
  description?: string;
  tags?: string[];
  /** New uploads are private unless the caller explicitly chooses otherwise. */
  privacyStatus?: 'public' | 'private' | 'unlisted';
  categoryId?: string;
  postType?: YouTubeRequestedPostType;
  /** Exact credential approved in the publishing review. */
  credentialId?: number;
  /** Channel ID captured during the publishing review. */
  expectedChannelId?: string;
  videoMetadata?: YouTubeVideoMetadata;
  publishAt?: string | Date;
  defaultLanguage?: string;
  license?: 'youtube' | 'creativeCommon';
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
}

export interface YouTubePublishResult {
  success: boolean;
  platformPostId?: string;
  postUrl?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  /** True when it is unsafe to retry because Google may have accepted the upload. */
  ambiguous?: boolean;
  providerRequestId?: string;
  processingStatus?: string;
}

export interface YouTubeVideoProcessingState {
  processingStatus: string | null;
  uploadStatus: string | null;
  failureReason: string | null;
}

export interface YouTubeRemoteVideoResult {
  success: boolean;
  exists?: boolean;
  postUrl?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  ambiguous?: boolean;
}

export type YouTubeProcessingOutcome =
  | { state: 'pending'; message: string }
  | { state: 'succeeded' }
  | { state: 'failed'; code: 'YOUTUBE_PROCESSING_FAILED' | 'YOUTUBE_PROCESSING_TIMEOUT'; message: string };

export function classifyYouTubeProcessingState(
  processing: YouTubeVideoProcessingState | null,
  acceptedAt: Date,
  now = Date.now(),
): YouTubeProcessingOutcome {
  const timedOut = now - acceptedAt.getTime() > 24 * 60 * 60_000;
  const failed = processing?.processingStatus === 'failed'
    || processing?.processingStatus === 'terminated'
    || processing?.uploadStatus === 'failed'
    || processing?.uploadStatus === 'rejected'
    || processing?.uploadStatus === 'deleted';
  if (failed) {
    return {
      state: 'failed',
      code: 'YOUTUBE_PROCESSING_FAILED',
      message: processing?.failureReason || 'YouTube rejected the uploaded video during processing.',
    };
  }
  if (processing?.processingStatus === 'succeeded' || processing?.uploadStatus === 'processed') {
    return { state: 'succeeded' };
  }
  if (timedOut) {
    return {
      state: 'failed',
      code: 'YOUTUBE_PROCESSING_TIMEOUT',
      message: 'YouTube did not finish processing the upload within 24 hours.',
    };
  }
  return {
    state: 'pending',
    message: processing
      ? `YouTube accepted the upload and is ${processing.processingStatus || processing.uploadStatus || 'processing'} it.`
      : 'YouTube accepted the upload; processing status is not available yet.',
  };
}

export class YouTubePublishingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 422,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'YouTubePublishingError';
  }
}

/** OAuth grants required by the management endpoints, grouped by capability. */
export const YOUTUBE_CAPABILITY_SCOPES = {
  upload: 'https://www.googleapis.com/auth/youtube.upload',
  manage: 'https://www.googleapis.com/auth/youtube.force-ssl',
  analytics: 'https://www.googleapis.com/auth/yt-analytics.readonly',
  analyticsChannel: 'https://www.googleapis.com/auth/youtube.readonly',
} as const;

export type YouTubeChapter = { startSeconds: number; title: string };

export interface YouTubeVideoDetails {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  license?: 'youtube' | 'creativeCommon';
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  privacyStatus?: 'public' | 'private' | 'unlisted';
  /** Native scheduled publishing. YouTube requires private visibility. */
  publishAt?: string;
}

export function validateYouTubeChapters(chapters: YouTubeChapter[]): YouTubeChapter[] {
  if (!Array.isArray(chapters) || chapters.length < 3) {
    throw new YouTubePublishingError('YouTube chapters require at least three entries.', 'CHAPTERS_MINIMUM');
  }
  const normalized = chapters.map((chapter) => ({
    startSeconds: Number(chapter?.startSeconds), title: String(chapter?.title || '').trim(),
  }));
  if (normalized[0]?.startSeconds !== 0) {
    throw new YouTubePublishingError('The first YouTube chapter must start at 0:00.', 'CHAPTERS_MUST_START_AT_ZERO');
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const chapter = normalized[i];
    if (!Number.isInteger(chapter.startSeconds) || chapter.startSeconds < 0 || !chapter.title || chapter.title.length > 100) {
      throw new YouTubePublishingError('Each chapter needs a non-negative whole-second timestamp and a title of 100 characters or fewer.', 'INVALID_CHAPTER');
    }
    if (i > 0 && chapter.startSeconds - normalized[i - 1].startSeconds < 10) {
      throw new YouTubePublishingError('YouTube chapters must be at least ten seconds apart.', 'CHAPTERS_TOO_CLOSE');
    }
  }
  return normalized;
}

function chapterTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

/** Generates the description block callers can preview before updating YouTube. */
export function generateYouTubeChapterContent(description: string, chapters: YouTubeChapter[]): string {
  const valid = validateYouTubeChapters(chapters);
  const block = valid.map(chapter => `${chapterTimestamp(chapter.startSeconds)} ${chapter.title}`).join('\n');
  if (description.trim() === block || description.trim().endsWith(`\n\n${block}`)) return description.trim();
  return `${description.trim()}${description.trim() ? '\n\n' : ''}${block}`;
}

interface YouTubeCreds {
  userId: number;
  oauthClientId?: string;
  credentialId: number;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: Date | null;
  channelId?: string;
  grantedScopes: string[];
  providerApprovalStatus?: string | null;
  providerVerifiedAt?: Date | null;
  readinessErrorCode?: string | null;
}

function decryptStoredValue(value: string | null): string {
  if (!value) return '';
  try {
    return value.split(':').length === 3 ? decryptValue(value) : value;
  } catch {
    return value;
  }
}

/** Canonicalize legacy `shorts` and explicitly reject unsupported Community Posts. */
export function normalizeYouTubePostType(value: string | undefined): YouTubePostType {
  const postType = (value || 'video').toLowerCase();
  if (postType === 'short' || postType === 'shorts') return 'short';
  if (postType === 'video') return 'video';
  if (postType === 'community_post') {
    throw new YouTubePublishingError(
      'YouTube Community Posts cannot be published through the public YouTube Data API. Publish a video or Short instead.',
      'UNSUPPORTED_YOUTUBE_POST_TYPE',
    );
  }
  throw new YouTubePublishingError(
    `Unsupported YouTube post type: ${value}. Use video or short.`,
    'UNSUPPORTED_YOUTUBE_POST_TYPE',
  );
}

/** Validate fields before an upload or durable attempt is created. */
export function validateYouTubePublishInput(input: YouTubePublishInput): YouTubePostType {
  const postType = normalizeYouTubePostType(input.postType);
  if (!input.videoUrl?.trim()) {
    throw new YouTubePublishingError('A video URL is required for YouTube video and Short publishing.', 'VIDEO_REQUIRED');
  }
  if (!input.title?.trim()) {
    throw new YouTubePublishingError('A YouTube video title is required.', 'TITLE_REQUIRED');
  }
  if (input.title.length > 100) {
    throw new YouTubePublishingError('YouTube video titles must be 100 characters or fewer.', 'TITLE_TOO_LONG');
  }
  if (input.description && Buffer.byteLength(input.description, 'utf8') > 5000) {
    throw new YouTubePublishingError('YouTube video descriptions must be 5,000 UTF-8 bytes or fewer.', 'DESCRIPTION_TOO_LONG');
  }
  if (/[<>]/.test(input.title) || (input.description && /[<>]/.test(input.description))) {
    throw new YouTubePublishingError('YouTube titles and descriptions cannot contain < or >.', 'INVALID_VIDEO_TEXT');
  }
  // https://developers.google.com/youtube/v3/docs/videos#snippet.tags
  // Provider-added Shorts tags, separators and implicit quotes all count.
  const tags = normalizeYouTubeTags(input.tags, postType === 'short');
  const tagCharacters = tags.reduce((total, tag) => total + [...tag].length + (tag.includes(' ') ? 2 : 0), Math.max(0, tags.length - 1));
  if (tagCharacters > 500) {
    throw new YouTubePublishingError('YouTube tags must total at most 500 characters, including commas and quotes around tags with spaces.', 'TAGS_TOO_LONG');
  }
  if (input.privacyStatus && !['public', 'private', 'unlisted'].includes(input.privacyStatus)) {
    throw new YouTubePublishingError('YouTube privacy must be public, private, or unlisted.', 'INVALID_PRIVACY');
  }
  if (input.license && !['youtube', 'creativeCommon'].includes(input.license)) {
    throw new YouTubePublishingError('YouTube license must be youtube or creativeCommon.', 'INVALID_LICENSE');
  }
  if (input.defaultLanguage && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/i.test(input.defaultLanguage)) {
    throw new YouTubePublishingError('defaultLanguage must be a BCP-47 language code such as en or en-US.', 'INVALID_DEFAULT_LANGUAGE');
  }
  if (input.publishAt) {
    const publishAt = new Date(input.publishAt);
    if (Number.isNaN(publishAt.getTime()) || publishAt.getTime() <= Date.now() + 60_000) {
      throw new YouTubePublishingError('publishAt must be at least one minute in the future.', 'INVALID_PUBLISH_AT');
    }
    if (input.privacyStatus && input.privacyStatus !== 'private') {
      throw new YouTubePublishingError('YouTube-native scheduled publishing requires private visibility.', 'SCHEDULED_PUBLISH_REQUIRES_PRIVATE');
    }
  }
  if (postType === 'short') validateShortMetadata(input.videoMetadata);
  return postType;
}

/**
 * YouTube currently classifies square or vertical videos up to three minutes
 * as Shorts. Dimensions/duration are optional because remote media metadata is
 * not always available, but known invalid metadata is rejected before upload.
 */
export function validateShortMetadata(metadata?: YouTubeVideoMetadata): void {
  if (!metadata) return;
  if (metadata.durationSeconds !== undefined && (
    !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0 || metadata.durationSeconds > 180
  )) {
    throw new YouTubePublishingError(
      'YouTube Shorts must be longer than 0 and no more than 180 seconds.',
      'SHORT_DURATION_INVALID',
    );
  }
  const { width, height } = metadata;
  if ((width === undefined) !== (height === undefined)
    || (width !== undefined && (!Number.isFinite(width) || !Number.isFinite(height!) || width <= 0 || height! <= 0))) {
    throw new YouTubePublishingError('Short video dimensions must include positive width and height values.', 'SHORT_DIMENSIONS_INVALID');
  }
  if (width !== undefined && height !== undefined && height < width) {
    throw new YouTubePublishingError(
      'YouTube Shorts must be square or vertical (height must be at least the width).',
      'SHORT_ASPECT_RATIO_INVALID',
    );
  }
}

export function normalizeYouTubeTags(tags: string[] | undefined, isShort: boolean): string[] {
  const normalized = [...new Set((tags || []).map(tag => tag.trim()).filter(Boolean))];
  if (isShort && !normalized.some(tag => tag.toLowerCase() === 'shorts' || tag.toLowerCase() === '#shorts')) {
    normalized.push('Shorts');
  }
  return normalized;
}

export async function listYouTubePublishingAccounts(userId: number, queryDb: typeof db = db): Promise<Array<{
  credentialId: number;
  platform: 'youtube';
  providerAccountId: string;
  accountName: string;
  expiresAt: string | null;
  expired: boolean;
  readiness: 'ready' | 'needs_reconnect';
  isSelected: boolean;
}>> {
  const rows = await queryDb.select({
    id: channelCredentialsTable.id,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
    accountName: channelCredentialsTable.accountName,
    tokenExpiry: channelCredentialsTable.tokenExpiry,
    refreshToken: channelCredentialsTable.refreshToken,
    isSelected: channelCredentialsTable.isSelected,
  }).from(channelCredentialsTable).where(and(
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.platform, 'youtube'),
    eq(channelCredentialsTable.isActive, true),
  ));
  return rows.filter((row: typeof rows[number]) => Boolean(row.accountIdentifier)).map((row: typeof rows[number]) => {
    const expired = Boolean(row.tokenExpiry && row.tokenExpiry.getTime() <= Date.now());
    return {
      credentialId: row.id,
      platform: 'youtube' as const,
      providerAccountId: row.accountIdentifier!,
      accountName: row.accountName || row.accountIdentifier!,
      expiresAt: row.tokenExpiry?.toISOString() || null,
      expired,
      readiness: expired && !row.refreshToken ? 'needs_reconnect' as const : 'ready' as const,
      isSelected: row.isSelected,
    };
  });
}

async function loadYouTubeCreds(
  userId: number,
  credentialId?: number,
  expectedChannelId?: string,
): Promise<YouTubeCreds | null> {
  const rows = await db.select().from(channelCredentialsTable).where(and(
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.platform, 'youtube'),
    eq(channelCredentialsTable.isActive, true),
    ...(credentialId ? [eq(channelCredentialsTable.id, credentialId)] : []),
  )).limit(2);
  if (!rows[0]) return null;
  if (!credentialId && rows.length > 1) {
    throw new YouTubePublishingError('Select the YouTube channel to publish to.', 'PUBLISHING_ACCOUNT_SELECTION_REQUIRED', 409);
  }
  const row = rows[0];
  if (expectedChannelId && row.accountIdentifier !== expectedChannelId) {
    throw new YouTubePublishingError('The selected YouTube channel no longer matches the approved publishing request.', 'CHANNEL_IDENTITY_MISMATCH', 409);
  }
  return {
    userId,
    oauthClientId: (row.sessionData as { oauthClientId?: string } | null)?.oauthClientId,
    credentialId: row.id,
    accessToken: decryptStoredValue(row.accessToken),
    refreshToken: row.refreshToken ? decryptStoredValue(row.refreshToken) : undefined,
    tokenExpiry: row.tokenExpiry ?? null,
    channelId: row.accountIdentifier || undefined,
    grantedScopes: Array.isArray(row.grantedScopes)
      ? row.grantedScopes.filter((scope: unknown): scope is string => typeof scope === 'string')
      : (typeof (row.sessionData as { scope?: unknown } | null)?.scope === 'string'
        ? String((row.sessionData as { scope: string }).scope).split(/\s+/).filter(Boolean)
        : []),
    providerApprovalStatus: row.providerApprovalStatus,
    providerVerifiedAt: row.providerVerifiedAt,
    readinessErrorCode: row.readinessErrorCode,
  };
}

function assertYouTubeCapability(creds: YouTubeCreds, capability: keyof typeof YOUTUBE_CAPABILITY_SCOPES): void {
  if (creds.providerApprovalStatus === 'denied') {
    throw new YouTubePublishingError('The selected YouTube credential has been denied by the provider.', 'YOUTUBE_CREDENTIAL_NOT_READY', 403);
  }
  if (creds.readinessErrorCode && creds.readinessErrorCode !== 'OFFICIAL_PROVIDER_REAUTHORIZATION_REQUIRED') {
    throw new YouTubePublishingError('The selected YouTube credential is not ready. Reconnect it and try again.', 'YOUTUBE_CREDENTIAL_NOT_READY', 403);
  }
  const required = YOUTUBE_CAPABILITY_SCOPES[capability];
  // youtube.force-ssl subsumes management API calls but does not imply Analytics.
  const hasScope = creds.grantedScopes.includes(required)
    || (capability === 'upload' && creds.grantedScopes.includes(YOUTUBE_CAPABILITY_SCOPES.manage));
  if (!hasScope) {
    throw new YouTubePublishingError(
      `The selected YouTube channel must be reconnected with the ${capability} permission before this action can run.`,
      'YOUTUBE_SCOPE_REQUIRED',
      403,
    );
  }
}

async function authorizedYouTube(
  userId: number,
  credentialId: number,
  capability: 'upload' | 'manage' | 'analytics',
  expectedChannelId?: string,
): Promise<{ creds: YouTubeCreds; youtube: Awaited<ReturnType<typeof createYouTubeClient>> }> {
  const creds = await loadYouTubeCreds(userId, credentialId, expectedChannelId);
  if (!creds?.accessToken) throw new YouTubePublishingError('The selected YouTube channel is not connected.', 'YOUTUBE_NOT_CONNECTED', 404);
  assertYouTubeCapability(creds, capability);
  await ensureYouTubeAccessToken(creds);
  return { creds, youtube: await createYouTubeClient(creds.accessToken) };
}

async function createYouTubeClient(accessToken: string) {
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.youtube({ version: 'v3', auth: oauth2, timeout: 30_000, retry: false });
}

/** Readiness is deliberately credential-specific so a selected channel cannot borrow another tenant's grant. */
export async function getYouTubeCapabilityReadiness(userId: number, credentialId: number) {
  const creds = await loadYouTubeCreds(userId, credentialId);
  if (!creds?.accessToken) return { ready: false, code: 'YOUTUBE_NOT_CONNECTED', scopes: [], quotaForecast: null };
  const missingScopes = Object.entries(YOUTUBE_CAPABILITY_SCOPES)
    .filter(([, scope]) => !creds.grantedScopes.includes(scope) && !(scope === YOUTUBE_CAPABILITY_SCOPES.upload && creds.grantedScopes.includes(YOUTUBE_CAPABILITY_SCOPES.manage)))
    .map(([capability]) => capability);
  const expired = Boolean(creds.tokenExpiry && creds.tokenExpiry.getTime() <= Date.now() && !creds.refreshToken);
  const ready = !expired && creds.providerApprovalStatus !== 'denied' && !creds.readinessErrorCode && missingScopes.length === 0;
  return {
    ready,
    code: expired ? 'YOUTUBE_AUTH_EXPIRED' : (creds.readinessErrorCode || (missingScopes.length ? 'YOUTUBE_SCOPE_REQUIRED' : undefined)),
    channelId: creds.channelId || null,
    scopes: creds.grantedScopes,
    missingCapabilities: missingScopes,
    // Google does not expose remaining daily project quota via Data API. These
    // are request cost estimates, not a claim about remaining quota.
    quotaForecast: { directVideoUploadUnits: 1600, metadataUpdateUnits: 50, analyticsQueryUnits: 1, remainingDailyUnits: null },
  };
}

async function googleOAuthClientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  // Gmail OAuth is the configured shared Google client in this application.
  const adminCred = await getActiveAdminCredential('gmail_oauth');
  return {
    clientId: adminCred?.apiKey || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: adminCred?.apiSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  };
}

async function refreshYouTubeToken(creds: YouTubeCreds): Promise<string | null> {
  try {
    const { clientId, clientSecret } = await googleOAuthClientCredentials();
    const result = await refreshChannelCredential({ userId: creds.userId, credentialId: creds.credentialId,
      platform: 'youtube', accountIdentifier: creds.channelId }, async current => {
      const issuingClient = (current.sessionData as { oauthClientId?: string } | null)?.oauthClientId;
      if (!clientId || !clientSecret || (issuingClient && issuingClient !== clientId)) throw new Error('YouTube OAuth configuration changed');
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptStoredValue(current.refreshToken), client_id: clientId, client_secret: clientSecret }),
      });
      const data = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
      if (!response.ok) throw Object.assign(new Error('YouTube token refresh rejected'), { response: { data: { error: data.error } } });
      if (!data.access_token || !data.expires_in) throw new Error('YouTube refresh receipt incomplete');
      return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(Date.now()+data.expires_in*1000) };
    });
    if (!result.credential) return null;
    creds.tokenExpiry = result.credential.tokenExpiry;
    creds.refreshToken = decryptStoredValue(result.credential.refreshToken);
    return decryptStoredValue(result.credential.accessToken);
  } catch {
    logger.warn({ credentialId: creds.credentialId }, '[YouTubePublishing] Token refresh unavailable');
    return null;
  }
}

async function ensureYouTubeAccessToken(creds: YouTubeCreds): Promise<string> {
  const expiresSoon = Boolean(creds.tokenExpiry && creds.tokenExpiry.getTime() - Date.now() <= 60_000);
  if (creds.refreshToken && expiresSoon) {
    const token = await refreshYouTubeToken(creds);
    if (token) {
      creds.accessToken = token;
      return token;
    }
    if (creds.tokenExpiry && creds.tokenExpiry.getTime() <= Date.now()) {
      throw new YouTubePublishingError(
        'YouTube authorization expired. Reconnect the channel and try again.',
        'YOUTUBE_AUTH_EXPIRED',
        401,
      );
    }
  } else if (creds.tokenExpiry && creds.tokenExpiry.getTime() <= Date.now()) {
    throw new YouTubePublishingError(
      'YouTube authorization expired. Reconnect the channel and try again.',
      'YOUTUBE_AUTH_EXPIRED',
      401,
    );
  }
  return creds.accessToken;
}

/** Refreshes only the exact tenant-owned credential used by a release canary. */
export async function getYouTubeVerificationAccessToken(userId: number, credentialId: number): Promise<string | null> {
  const creds = await loadYouTubeCreds(userId, credentialId);
  if (!creds?.accessToken) return null;
  try {
    return await ensureYouTubeAccessToken(creds);
  } catch {
    return null;
  }
}

export function classifyYouTubeError(error: unknown): Pick<YouTubePublishResult, 'error' | 'errorCode' | 'retryable' | 'ambiguous'> {
  const message = error instanceof Error ? error.message : 'YouTube publishing failed';
  const status = typeof error === 'object' && error !== null && 'code' in error ? Number((error as { code?: unknown }).code) : undefined;
  const providerReason = typeof error === 'object' && error !== null
    ? JSON.stringify((error as { errors?: unknown; response?: { data?: unknown } }).errors ?? (error as { response?: { data?: unknown } }).response?.data ?? '')
    : '';
  if (error instanceof YouTubePublishingError) return { error: message, errorCode: error.code, retryable: false, ...(error.ambiguous ? { ambiguous: true } : {}) };
  if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(`${message} ${providerReason}`)) {
    return { error: 'AskSales has reached its YouTube API quota. Try again after the quota resets or contact AskSales Support.', errorCode: 'YOUTUBE_QUOTA_EXCEEDED', retryable: true };
  }
  if (status === 403 && /insufficient.*scope|forbidden/i.test(`${message} ${providerReason}`)) {
    return { error: 'YouTube rejected this operation because the channel is missing a required permission. Reconnect the channel.', errorCode: 'YOUTUBE_SCOPE_REQUIRED', retryable: false };
  }
  if (status === 401 || /invalid_grant|invalid credentials|unauthorized/i.test(message)) {
    return { error: 'YouTube authorization expired. Reconnect the YouTube channel and try again.', errorCode: 'YOUTUBE_AUTH_EXPIRED', retryable: false };
  }
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { error: message, errorCode: 'YOUTUBE_TRANSIENT_ERROR', retryable: true };
  }
  // A transport failure after the request begins has no safe retry path. The
  // durable attempt will be quarantined instead of risking a duplicate upload.
  if (/network|socket|timeout|timed out|connection reset/i.test(message)) {
    return { error: message, errorCode: 'YOUTUBE_OUTCOME_UNKNOWN', ambiguous: true, retryable: false };
  }
  return { error: message, errorCode: 'YOUTUBE_UPLOAD_FAILED', retryable: false };
}

export async function publishToYouTube(userId: number, input: YouTubePublishInput): Promise<YouTubePublishResult> {
  let postType: YouTubePostType;
  try {
    postType = validateYouTubePublishInput(input);
  } catch (error) {
    return { success: false, ...classifyYouTubeError(error) };
  }
  let creds: YouTubeCreds | null;
  try {
    creds = await loadYouTubeCreds(userId, input.credentialId, input.expectedChannelId);
  } catch (error) {
    return { success: false, ...classifyYouTubeError(error) };
  }
  if (!creds?.accessToken) {
    return { success: false, error: 'YouTube channel not connected. Connect a channel in Settings → Channels.', errorCode: 'YOUTUBE_NOT_CONNECTED' };
  }

  try {
    await ensureYouTubeAccessToken(creds);
  } catch (error) {
    return { success: false, ...classifyYouTubeError(error) };
  }

  try {
    const { response, finalUrl } = await fetchPublicHttpUrl(input.videoUrl!, { headers: { accept: 'video/*,application/octet-stream;q=0.8' } });
    if (!response.ok) throw new YouTubePublishingError(`Video download failed with HTTP ${response.status}.`, 'VIDEO_DOWNLOAD_FAILED', 422);
    if (!response.body) throw new YouTubePublishingError('Video download returned an empty body.', 'VIDEO_DOWNLOAD_EMPTY', 422);
    const declaredSize = Number(response.headers.get('content-length'));
    // The stream is never buffered in memory. This guard avoids accidental huge
    // unbounded transfers while allowing normal production videos.
    if (Number.isFinite(declaredSize) && declaredSize > 10 * 1024 * 1024 * 1024) {
      await response.body.cancel();
      throw new YouTubePublishingError('Video exceeds this publisher’s 10 GB transfer limit. Upload it to approved storage or reduce the file size.', 'VIDEO_TOO_LARGE');
    }
    const { google } = await import('googleapis');
    const { Readable } = await import('node:stream');
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: creds.accessToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    const isShort = postType === 'short';
    const upload = await youtube.videos.insert({
      // Google API client selects a resumable upload session for this media body.
      uploadType: 'resumable',
      part: ['snippet', 'status', 'processingDetails'],
      requestBody: {
        snippet: {
          title: input.title.trim(), description: (input.description || '').trim(),
          tags: normalizeYouTubeTags(input.tags, isShort), categoryId: input.categoryId || '22',
          defaultLanguage: input.defaultLanguage,
        },
        status: {
          privacyStatus: input.publishAt ? 'private' : (input.privacyStatus || 'private'),
          publishAt: input.publishAt ? new Date(input.publishAt).toISOString() : undefined,
          selfDeclaredMadeForKids: input.madeForKids ?? false,
          containsSyntheticMedia: input.containsSyntheticMedia,
          license: input.license,
        },
      },
      media: {
        mimeType: response.headers.get('content-type') || 'video/*',
        body: Readable.fromWeb(response.body as never),
      },
    });
    const videoId = upload.data?.id;
    if (typeof videoId !== 'string' || !videoId.trim()) {
      return {
        success: false,
        error: 'YouTube accepted the upload without returning a video ID. Check the channel before retrying.',
        errorCode: 'YOUTUBE_OUTCOME_UNKNOWN',
        ambiguous: true,
        retryable: false,
      };
    }
    const processingStatus = upload.data.processingDetails?.processingStatus || 'processing';
    logger.info({ userId, credentialId: creds.credentialId, channelId: creds.channelId, videoId, finalUrl, processingStatus }, '[YouTubePublishing] Video accepted by YouTube');
    const requestId = upload.headers?.['x-guploader-uploadid'];
    return { success: true, platformPostId: videoId, postUrl: `https://youtu.be/${videoId}`, providerRequestId: Array.isArray(requestId) ? requestId[0] : requestId, processingStatus };
  } catch (error) {
    logger.error({ err: error, userId, credentialId: creds.credentialId }, '[YouTubePublishing] Upload failed');
    return { success: false, ...classifyYouTubeError(error) };
  }
}

export interface YouTubeUploadSession {
  uploadUrl: string;
  sessionToken: string;
  expiresAt: string;
}

type UploadSessionPayload = {
  userId: number;
  credentialId: number;
  channelId?: string;
  uploadUrl: string;
  /** Bound at session creation so a signed session cannot be repurposed for a different file. */
  contentLength: number;
  contentType: string;
  expiresAt: number;
};

function signUploadSession(payload: UploadSessionPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = uploadSessionHmac(encoded);
  return `${encoded}.${signature}`;
}

function uploadSessionHmac(value: string): string {
  // The upload URL itself is already delivered to the browser. This signature
  // prevents a caller from substituting a session belonging to another tenant.
  const secret = process.env.PROVIDER_SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new YouTubePublishingError(
      'Direct upload sessions are unavailable until a strong provider-session signing secret is configured.',
      'UPLOAD_SESSION_SIGNING_NOT_CONFIGURED',
      503,
    );
  }
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function isGoogleUploadSessionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'www.googleapis.com' || url.hostname.endsWith('.googleapis.com'))
      && url.pathname.startsWith('/upload/youtube/v3/videos')
      && url.searchParams.get('uploadType') === 'resumable';
  } catch {
    return false;
  }
}

function verifyUploadSession(token: string, userId: number): UploadSessionPayload {
  const [encoded, signature] = token.split('.');
  const expected = encoded ? uploadSessionHmac(encoded) : '';
  if (!encoded || !signature || Buffer.byteLength(expected) !== Buffer.byteLength(signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    throw new YouTubePublishingError('The direct upload session is invalid.', 'INVALID_UPLOAD_SESSION', 403);
  }
  let payload: UploadSessionPayload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UploadSessionPayload; } catch {
    throw new YouTubePublishingError('The direct upload session is invalid.', 'INVALID_UPLOAD_SESSION', 403);
  }
  if (payload.userId !== userId
    || payload.expiresAt < Date.now()
    || !Number.isSafeInteger(payload.contentLength)
    || payload.contentLength <= 0
    || payload.contentLength > 256 * 1024 * 1024 * 1024
    || !/^video\/[a-z0-9.+-]+$/i.test(payload.contentType)
    || !isGoogleUploadSessionUrl(payload.uploadUrl)) {
    throw new YouTubePublishingError('The direct upload session has expired or does not belong to this tenant.', 'INVALID_UPLOAD_SESSION', 403);
  }
  return payload;
}

/**
 * Starts a Google resumable upload. Subsequent bounded chunks are forwarded by
 * this service because Google's protocol requires an OAuth bearer token on
 * every PUT; the full media file is never buffered by the application.
 */
export async function initiateYouTubeResumableUpload(
  userId: number,
  credentialId: number,
  input: Omit<YouTubePublishInput, 'videoUrl' | 'credentialId' | 'expectedChannelId'> & { contentType: string; contentLength: number },
): Promise<YouTubeUploadSession> {
  validateYouTubePublishInput({ ...input, videoUrl: 'direct-provider-upload', credentialId });
  if (!/^video\/[a-z0-9.+-]+$/i.test(input.contentType) || !Number.isSafeInteger(input.contentLength) || input.contentLength <= 0 || input.contentLength > 256 * 1024 * 1024 * 1024) {
    throw new YouTubePublishingError('contentType must be a video MIME type and contentLength must be between 1 byte and 256 GB.', 'INVALID_UPLOAD_MEDIA');
  }
  const { creds } = await authorizedYouTube(userId, credentialId, 'upload');
  const postType = normalizeYouTubePostType(input.postType);
  const response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': input.contentType,
      'x-upload-content-length': String(input.contentLength),
    },
    body: JSON.stringify({
      snippet: {
        title: input.title.trim(), description: (input.description || '').trim(),
        tags: normalizeYouTubeTags(input.tags, postType === 'short'), categoryId: input.categoryId || '22',
        defaultLanguage: input.defaultLanguage,
      },
      status: {
        privacyStatus: input.publishAt ? 'private' : (input.privacyStatus || 'private'),
        publishAt: input.publishAt ? new Date(input.publishAt).toISOString() : undefined,
        selfDeclaredMadeForKids: input.madeForKids ?? false,
        containsSyntheticMedia: input.containsSyntheticMedia,
        license: input.license,
      },
    }),
  });
  const uploadUrl = response.headers.get('location');
  if (!response.ok || !uploadUrl) throw new YouTubePublishingError(`YouTube did not create an upload session (${response.status}).`, 'YOUTUBE_UPLOAD_SESSION_FAILED', response.status >= 500 ? 502 : 422);
  const expiresAt = Date.now() + 8 * 60 * 60_000;
  return {
    uploadUrl,
    expiresAt: new Date(expiresAt).toISOString(),
    sessionToken: signUploadSession({
      userId,
      credentialId,
      channelId: creds.channelId,
      uploadUrl,
      contentLength: input.contentLength,
      contentType: input.contentType,
      expiresAt,
    }),
  };
}

/** Queries a resumable session offset without accepting any media bytes. */
export async function getYouTubeResumableUploadStatus(userId: number, sessionToken: string, contentLength: number) {
  const session = verifyUploadSession(sessionToken, userId);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength !== session.contentLength) {
    throw new YouTubePublishingError('contentLength must match the file bound to this upload session.', 'INVALID_UPLOAD_MEDIA');
  }
  const { creds } = await authorizedYouTube(userId, session.credentialId, 'upload', session.channelId);
  const response = await fetch(session.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${creds.accessToken}`, 'content-length': '0', 'content-range': `bytes */${contentLength}` } });
  if (response.status === 308) {
    const range = response.headers.get('range');
    const uploadedBytes = range ? Number(range.split('-')[1]) + 1 : 0;
    return { complete: false, uploadedBytes: Number.isFinite(uploadedBytes) ? uploadedBytes : 0 };
  }
  if (response.ok) return { complete: true, video: await response.json() };
  throw new YouTubePublishingError(`YouTube upload status check failed (${response.status}).`, 'YOUTUBE_UPLOAD_STATUS_FAILED', response.status >= 500 ? 502 : 422);
}

/**
 * Validate the browser-supplied range before a chunk can reach Google.  This
 * makes the signed session file-size-specific and keeps buffer/range checks
 * independently testable without provider credentials.
 */
export function validateYouTubeResumableChunkRange(
  contentRange: string,
  chunkLength: number,
  expectedContentLength: number,
): { first: number; last: number; total: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (!match || !Number.isSafeInteger(chunkLength) || chunkLength < 1 || chunkLength > 16 * 1024 * 1024) {
    throw new YouTubePublishingError('Upload chunks must be contiguous and no larger than 16 MB.', 'INVALID_UPLOAD_CHUNK');
  }
  const first = Number(match[1]);
  const last = Number(match[2]);
  const total = Number(match[3]);
  if (![first, last, total, expectedContentLength].every(Number.isSafeInteger)
    || first < 0
    || last < first
    || total !== expectedContentLength
    || total <= last
    || total > 256 * 1024 * 1024 * 1024
    || last - first + 1 !== chunkLength) {
    throw new YouTubePublishingError('Content-Range does not match this upload session and chunk.', 'INVALID_UPLOAD_CHUNK');
  }
  return { first, last, total };
}

/**
 * Forwards one bounded, range-aligned chunk with the server-held OAuth token.
 * Google's protocol requires an Authorization header on every PUT; this keeps
 * that broad provider credential out of browser JavaScript while preserving
 * resumability and avoiding whole-file buffering in this process. Google is
 * the durable source of the current offset, which also allows a browser to
 * resume after this API process has been restarted.
 */
export async function uploadYouTubeResumableChunk(
  userId: number,
  sessionToken: string,
  contentRange: string,
  contentType: string,
  chunk: Buffer,
) {
  const session = verifyUploadSession(sessionToken, userId);
  if (!Buffer.isBuffer(chunk)) throw new YouTubePublishingError('Upload chunk must be binary media data.', 'INVALID_UPLOAD_CHUNK');
  if (contentType !== session.contentType) {
    throw new YouTubePublishingError('Upload chunk media type must match the file bound to this upload session.', 'INVALID_UPLOAD_CHUNK');
  }
  validateYouTubeResumableChunkRange(contentRange, chunk.length, session.contentLength);
  const { creds } = await authorizedYouTube(userId, session.credentialId, 'upload', session.channelId);
  const response = await fetch(session.uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${creds.accessToken}`,
      'content-type': session.contentType,
      'content-length': String(chunk.length),
      'content-range': contentRange,
    },
    body: chunk,
  });
  if (response.status === 308) {
    const range = response.headers.get('range');
    const uploadedBytes = range ? Number(range.split('-')[1]) + 1 : 0;
    return { complete: false, uploadedBytes: Number.isFinite(uploadedBytes) ? uploadedBytes : 0 };
  }
  if (response.ok) {
    const video = await response.json() as { id?: string; status?: { uploadStatus?: string } };
    return { complete: true, videoId: video.id || null, processingStatus: video.status?.uploadStatus || 'uploaded' };
  }
  throw new YouTubePublishingError(`YouTube rejected the upload chunk (${response.status}).`, 'YOUTUBE_UPLOAD_CHUNK_FAILED', response.status >= 500 ? 502 : 422);
}

/** Verifies the provider result and channel before the UI treats a direct upload as finalized. */
export async function finalizeYouTubeResumableUpload(userId: number, sessionToken: string, videoId: string) {
  const session = verifyUploadSession(sessionToken, userId);
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw new YouTubePublishingError('Invalid YouTube video ID.', 'INVALID_VIDEO_ID');
  const { youtube } = await authorizedYouTube(userId, session.credentialId, 'upload', session.channelId);
  const response = await youtube.videos.list({ part: ['id', 'snippet', 'status', 'processingDetails'], id: [videoId] });
  const video = response.data.items?.[0];
  if (!video?.id) throw new YouTubePublishingError('YouTube has not made this uploaded video available yet.', 'YOUTUBE_UPLOAD_NOT_FINALIZED', 409);
  if (session.channelId && video.snippet?.channelId !== session.channelId) {
    throw new YouTubePublishingError('The uploaded video does not belong to the channel selected for this upload session.', 'YOUTUBE_UPLOAD_CHANNEL_MISMATCH', 409);
  }
  return { videoId: video.id, postUrl: `https://youtu.be/${video.id}`, processingStatus: video.processingDetails?.processingStatus || video.status?.uploadStatus || 'processing' };
}

export async function updateYouTubeVideoDetails(userId: number, credentialId: number, videoId: string, details: YouTubeVideoDetails) {
  if (!videoId) throw new YouTubePublishingError('videoId is required.', 'INVALID_VIDEO_ID');
  if (details.publishAt && details.privacyStatus && details.privacyStatus !== 'private') throw new YouTubePublishingError('YouTube-native scheduled publishing requires private visibility.', 'SCHEDULED_PUBLISH_REQUIRES_PRIVATE');
  if (details.publishAt) {
    const publishAt = new Date(details.publishAt);
    if (Number.isNaN(publishAt.getTime()) || publishAt.getTime() <= Date.now() + 60_000) {
      throw new YouTubePublishingError('publishAt must be at least one minute in the future.', 'INVALID_PUBLISH_AT');
    }
  }
  if (details.defaultLanguage && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/i.test(details.defaultLanguage)) throw new YouTubePublishingError('defaultLanguage must be a BCP-47 language code.', 'INVALID_DEFAULT_LANGUAGE');
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const current = await youtube.videos.list({ part: ['snippet', 'status'], id: [videoId] });
  const existing = current.data.items?.[0];
  if (!existing?.id) throw new YouTubePublishingError('Video was not found for the selected channel.', 'YOUTUBE_VIDEO_NOT_FOUND', 404);
  // Metadata edits must obey the same provider text/options constraints as
  // new uploads. Validate the resulting text while preserving omitted fields.
  validateYouTubePublishInput({
    ...details,
    videoUrl: 'existing-provider-video',
    title: details.title ?? existing.snippet?.title ?? '',
    description: details.description ?? existing.snippet?.description ?? undefined,
    tags: details.tags ?? existing.snippet?.tags ?? undefined,
  });
  const response = await youtube.videos.update({
    part: ['snippet', 'status'],
    requestBody: {
      id: videoId,
      snippet: { ...existing.snippet, title: details.title ?? existing.snippet?.title, description: details.description ?? existing.snippet?.description, tags: details.tags ?? existing.snippet?.tags, categoryId: details.categoryId ?? existing.snippet?.categoryId, defaultLanguage: details.defaultLanguage ?? existing.snippet?.defaultLanguage },
      status: { ...existing.status, privacyStatus: details.publishAt ? 'private' : (details.privacyStatus ?? existing.status?.privacyStatus), publishAt: details.publishAt ? new Date(details.publishAt).toISOString() : existing.status?.publishAt, license: details.license ?? existing.status?.license, selfDeclaredMadeForKids: details.madeForKids ?? existing.status?.selfDeclaredMadeForKids, containsSyntheticMedia: details.containsSyntheticMedia ?? existing.status?.containsSyntheticMedia },
    },
  });
  return response.data;
}

export async function validateYouTubePublishExtras(userId: number, credentialId: number, options: YouTubePublishingOptions) {
  if (!options.thumbnailUrl && !options.playlistId) return;
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  if (options.playlistId) {
    const playlists = await youtube.playlists.list({ part: ['id'], mine: true, maxResults: 50 });
    let items = playlists.data.items || [];
    let next = playlists.data.nextPageToken;
    while (!items.some(item => item.id === options.playlistId) && next) {
      const page = await youtube.playlists.list({ part: ['id'], mine: true, maxResults: 50, pageToken: next });
      items = page.data.items || [];
      next = page.data.nextPageToken;
    }
    if (!items.some(item => item.id === options.playlistId)) throw new YouTubePublishingError('Select a playlist owned by the connected YouTube account.', 'PLAYLIST_NOT_OWNED');
  }
  if (options.thumbnailUrl) await downloadYouTubeThumbnail(options.thumbnailUrl);
}

async function downloadYouTubeThumbnail(thumbnailUrl: string) {
  const { response } = await fetchPublicHttpUrl(thumbnailUrl, { signal: AbortSignal.timeout(20_000), headers: { accept: 'image/jpeg,image/png' } });
  if (!response.ok) throw new YouTubePublishingError('Could not fetch the selected thumbnail.', 'THUMBNAIL_DOWNLOAD_FAILED');
  const buffer = await readResponseBuffer(response, 2 * 1024 * 1024);
  const sharp = (await import('sharp')).default;
  const image = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
  if (!['jpeg', 'png'].includes(image.format || '')) throw new YouTubePublishingError('Use a JPEG or PNG thumbnail.', 'INVALID_THUMBNAIL_FORMAT');
  return { buffer, mimeType: image.format === 'png' ? 'image/png' : 'image/jpeg' };
}

export async function setYouTubeThumbnail(userId: number, credentialId: number, videoId: string, thumbnailUrl: string) {
  if (!thumbnailUrl?.startsWith('https://')) throw new YouTubePublishingError('thumbnailUrl must be an HTTPS URL.', 'INVALID_THUMBNAIL_URL');
  const { creds, youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const { buffer, mimeType } = await downloadYouTubeThumbnail(thumbnailUrl);
  const { Readable } = await import('node:stream');
  const result = await youtube.thumbnails.set({ videoId, media: { mimeType, body: Readable.from(buffer) } });
  logger.info({ userId, credentialId: creds.credentialId, videoId }, '[YouTubePublishing] Thumbnail set');
  return result.data;
}

export async function listYouTubePlaylists(userId: number, credentialId: number) {
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const response = await youtube.playlists.list({ part: ['id', 'snippet', 'contentDetails'], mine: true, maxResults: 50 });
  return (response.data.items || []).map(item => ({ id: item.id, title: item.snippet?.title || '', itemCount: item.contentDetails?.itemCount || 0 }));
}

export async function assignYouTubePlaylist(userId: number, credentialId: number, videoId: string, playlistId: string) {
  if (!videoId || !playlistId) throw new YouTubePublishingError('videoId and playlistId are required.', 'INVALID_PLAYLIST_ASSIGNMENT');
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const existing = await youtube.playlistItems.list({ part: ['id'], playlistId, videoId, maxResults: 1 });
  if (existing.data.items?.[0]?.id) return { playlistItemId: existing.data.items[0].id, playlistId, videoId };
  const response = await youtube.playlistItems.insert({ part: ['snippet'], requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } } });
  return { playlistItemId: response.data.id, playlistId, videoId };
}

export async function listYouTubeCaptions(userId: number, credentialId: number, videoId: string) {
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const response = await youtube.captions.list({ part: ['id', 'snippet'], videoId });
  return (response.data.items || []).map(item => ({ id: item.id, language: item.snippet?.language, name: item.snippet?.name, trackKind: item.snippet?.trackKind, status: item.snippet?.status }));
}

export async function uploadYouTubeCaption(userId: number, credentialId: number, input: { videoId: string; captionUrl: string; language: string; name?: string; isDraft?: boolean }) {
  if (!input.captionUrl?.startsWith('https://') || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/i.test(input.language)) throw new YouTubePublishingError('captionUrl must be HTTPS and language must be a BCP-47 code.', 'INVALID_CAPTION_INPUT');
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const { response } = await fetchPublicHttpUrl(input.captionUrl, { headers: { accept: 'text/vtt,text/plain,application/octet-stream' } });
  if (!response.ok || !response.body) throw new YouTubePublishingError('Could not fetch the caption track.', 'CAPTION_DOWNLOAD_FAILED');
  const { Readable } = await import('node:stream');
  const result = await youtube.captions.insert({ part: ['snippet'], requestBody: { snippet: { videoId: input.videoId, language: input.language, name: input.name || '', isDraft: input.isDraft ?? false } }, media: { mimeType: response.headers.get('content-type') || 'text/vtt', body: Readable.fromWeb(response.body as never) } });
  return { id: result.data.id, snippet: result.data.snippet };
}

export async function deleteYouTubeCaption(userId: number, credentialId: number, captionId: string) {
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  await youtube.captions.delete({ id: captionId });
  return { deleted: true, captionId };
}

export async function listYouTubeComments(userId: number, credentialId: number, videoId: string, pageToken?: string) {
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  const response = await youtube.commentThreads.list({ part: ['id', 'snippet', 'replies'], videoId, maxResults: 100, pageToken, textFormat: 'plainText', order: 'time' });
  return { nextPageToken: response.data.nextPageToken, comments: (response.data.items || []).map(item => ({ id: item.id, topLevelCommentId: item.snippet?.topLevelComment?.id, author: item.snippet?.topLevelComment?.snippet?.authorDisplayName, text: item.snippet?.topLevelComment?.snippet?.textDisplay, publishedAt: item.snippet?.topLevelComment?.snippet?.publishedAt, moderationStatus: item.snippet?.topLevelComment?.snippet?.moderationStatus, replies: (item.replies?.comments || []).map(reply => ({ id: reply.id, author: reply.snippet?.authorDisplayName, text: reply.snippet?.textDisplay, publishedAt: reply.snippet?.publishedAt })) })) };
}

export async function moderateYouTubeComment(userId: number, credentialId: number, commentId: string, moderationStatus: 'published' | 'heldForReview' | 'rejected') {
  if (!commentId || !['published', 'heldForReview', 'rejected'].includes(moderationStatus)) {
    throw new YouTubePublishingError('A valid comment ID and moderation status are required.', 'INVALID_MODERATION_ACTION');
  }
  const { youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  await youtube.comments.setModerationStatus({ id: [commentId], moderationStatus });
  return { commentId, moderationStatus };
}

export async function replyToYouTubeComment(userId: number, credentialId: number, parentId: string, textOriginal: string, intentKey = '') {
  const { assertCustomerDeliveryRuntime } = await import('../assistants/CustomerDeliveryGate.js');
  assertCustomerDeliveryRuntime('youtube');
  if (!textOriginal?.trim() || textOriginal.length > 10_000) throw new YouTubePublishingError('Reply text must be between 1 and 10,000 characters.', 'INVALID_COMMENT_REPLY');
  if (!parentId || parentId.length > 255) throw new YouTubePublishingError('A valid parent comment is required.', 'INVALID_COMMENT_REPLY');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(intentKey)) throw new YouTubePublishingError('A reviewed reply request key is required.', 'YOUTUBE_REPLY_INTENT_REQUIRED', 400);
  const { creds, youtube } = await authorizedYouTube(userId, credentialId, 'manage');
  if (!creds.channelId) throw new YouTubePublishingError('The selected credential has no channel identity.', 'YOUTUBE_CHANNEL_ID_REQUIRED', 409);
  const { reserveYouTubeCommentIntent, completeYouTubeCommentIntent, quarantineYouTubeCommentIntent } = await import('./YouTubeCommentIntentService.js');
  const intent = await reserveYouTubeCommentIntent(userId, credentialId, creds.channelId, parentId, textOriginal.trim(), intentKey)
    .catch(error => {
      const authorization = error as { status?: number; code?: string; message?: string };
      if (authorization.status && authorization.status < 500 && authorization.code) {
        throw new YouTubePublishingError(authorization.message || 'Reply authority is unavailable.', authorization.code, authorization.status);
      }
      throw new YouTubePublishingError('Reply recovery is unavailable. No new reply was started.', 'YOUTUBE_REPLY_RECOVERY_UNAVAILABLE', 503);
    });
  if (!intent.created) {
    if (intent.conflict) throw new YouTubePublishingError('This reply key belongs to different reviewed content or authority.', 'YOUTUBE_REPLY_INTENT_CONFLICT', 409);
    if (intent.intent?.state === 'succeeded' && intent.intent.receipt?.id) return intent.intent.receipt;
    if (intent.intent?.state === 'rejected') throw new YouTubePublishingError(intent.intent.error_message || 'YouTube rejected this reply.', 'YOUTUBE_REPLY_REJECTED', intent.intent.error_status || 422);
    if (intent.intent?.receipt?.id) {
      await completeYouTubeCommentIntent(intent.intent.id, userId, intent.origin.businessProfileId, intent.intent.receipt)
        .catch(() => { throw new YouTubePublishingError('The saved reply receipt still needs confirmation. This request will not send again.', 'YOUTUBE_REPLY_UNCONFIRMED', 503, true); });
      return intent.intent.receipt;
    }
    throw new YouTubePublishingError('This reply is running or its result is unconfirmed. Check YouTube before composing another reply; this request will not send again.', 'YOUTUBE_REPLY_UNCONFIRMED', 409, true);
  }
  let acceptedReceipt: { id: string; snippet?: unknown } | undefined;
  try {
    const response = await youtube.comments.insert({ part: ['snippet'], requestBody: { snippet: { parentId, textOriginal: textOriginal.trim() } } });
    const id = response?.data?.id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('YouTube accepted the reply without a usable receipt.');
    acceptedReceipt = { id, snippet: response.data.snippet };
    await completeYouTubeCommentIntent(intent.id, userId, intent.origin.businessProfileId, acceptedReceipt);
    return acceptedReceipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'YouTube reply outcome is unknown.';
    const providerError = error as { response?: { status?: number }; code?: number } | null;
    const status = Number(providerError?.response?.status || providerError?.code);
    const rejectedStatus = !acceptedReceipt && status >= 400 && status < 500 && status !== 408 ? status : undefined;
    // Failed receipt persistence still leaves the pre-dispatch fence closed.
    try { await quarantineYouTubeCommentIntent(intent.id, userId, intent.origin.businessProfileId, message, acceptedReceipt, rejectedStatus); }
    catch (receiptError) { logger.error({ err: receiptError, userId, intentId: intent.id }, '[YouTubePublishing] Reply outcome remains unconfirmed'); }
    if (rejectedStatus) throw new YouTubePublishingError(message, 'YOUTUBE_REPLY_REJECTED', rejectedStatus);
    throw new YouTubePublishingError(message, 'YOUTUBE_REPLY_OUTCOME_UNKNOWN', 502, true);
  }
}

/**
 * Fetches daily channel/video metrics from the YouTube Analytics API and
 * upserts a normalized tenant snapshot. Retention is not exposed by this API;
 * callers receive that as an explicit capability limitation rather than a
 * fabricated metric.
 */
export async function syncYouTubeAnalytics(
  userId: number,
  credentialId: number,
  input: { startDate: string; endDate: string; videoId?: string },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate) || input.startDate > input.endDate) {
    throw new YouTubePublishingError('startDate and endDate must be ISO dates with startDate no later than endDate.', 'INVALID_ANALYTICS_DATE_RANGE');
  }
  const start = new Date(`${input.startDate}T00:00:00.000Z`);
  const end = new Date(`${input.endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() - start.getTime() > 366 * 86_400_000) {
    throw new YouTubePublishingError('Analytics ranges must contain real dates and span no more than 366 days.', 'INVALID_ANALYTICS_DATE_RANGE');
  }
  if (input.videoId && !/^[A-Za-z0-9_-]{6,}$/.test(input.videoId)) {
    throw new YouTubePublishingError('Invalid YouTube video ID.', 'INVALID_VIDEO_ID');
  }
  const { creds } = await authorizedYouTube(userId, credentialId, 'analytics');
  if (!creds.grantedScopes.includes(YOUTUBE_CAPABILITY_SCOPES.analyticsChannel)) {
    throw new YouTubePublishingError(
      'The selected channel must be reconnected with YouTube read-only access before Analytics reports can run.',
      'YOUTUBE_SCOPE_REQUIRED',
      403,
    );
  }
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: creds.accessToken });
  const analytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2 });
  const response = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate: input.startDate,
    endDate: input.endDate,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost',
    dimensions: input.videoId ? 'day' : 'day,video',
    filters: input.videoId ? `video==${input.videoId}` : undefined,
    sort: 'day',
  });
  const headers = (response.data.columnHeaders || []).map(header => header.name || '');
  const snapshots = (response.data.rows || []).map((row) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    const metricDate = String(values.day || '');
    const videoId = String(values.video || input.videoId || '__channel__');
    const metrics = Object.fromEntries(Object.entries(values)
      .filter(([key]) => key !== 'day' && key !== 'video')
      .map(([key, value]) => [key, Number(value) || 0]));
    return { metricDate, videoId, metrics };
  }).filter(snapshot => /^\d{4}-\d{2}-\d{2}$/.test(snapshot.metricDate));
  if (!creds.channelId) throw new YouTubePublishingError('The selected credential has no channel identity.', 'YOUTUBE_CHANNEL_ID_REQUIRED', 409);
  for (const snapshot of snapshots) {
    await db.insert(youtubeAnalyticsSnapshotsTable).values({
      userId, credentialId, channelId: creds.channelId, videoId: snapshot.videoId, metricDate: snapshot.metricDate, metrics: snapshot.metrics, syncedAt: new Date(),
    }).onConflictDoUpdate({
      target: [youtubeAnalyticsSnapshotsTable.businessProfileId, youtubeAnalyticsSnapshotsTable.userId, youtubeAnalyticsSnapshotsTable.credentialId, youtubeAnalyticsSnapshotsTable.channelId, youtubeAnalyticsSnapshotsTable.videoId, youtubeAnalyticsSnapshotsTable.metricDate],
      set: { metrics: snapshot.metrics, syncedAt: sql`NOW()` },
    });
  }
  return { channelId: creds.channelId, snapshots, limitations: ['Audience-retention curves require YouTube Studio reporting and are not available from the public YouTube Analytics API used here.'] };
}

/** Query processing state without treating a processing failure as a republish opportunity. */
export async function getYouTubeVideoProcessingStatus(
  userId: number,
  credentialId: number,
  videoId: string,
): Promise<YouTubeVideoProcessingState | null> {
  const creds = await loadYouTubeCreds(userId, credentialId);
  if (!creds?.accessToken) return null;
  await ensureYouTubeAccessToken(creds);
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: creds.accessToken });
  const response = await google.youtube({ version: 'v3', auth: oauth2 }).videos.list({ part: ['processingDetails', 'status'], id: [videoId] });
  const video = response.data.items?.[0];
  if (!video) return null;
  return {
    processingStatus: video.processingDetails?.processingStatus || null,
    uploadStatus: video.status?.uploadStatus || null,
    failureReason: video.processingDetails?.processingFailureReason || video.status?.rejectionReason || null,
  };
}

/** Confirm whether an uploaded video still exists before clearing local state. */
export async function reconcileYouTubeVideo(
  userId: number,
  credentialId: number,
  videoId: string,
): Promise<YouTubeRemoteVideoResult> {
  try {
    const creds = await loadYouTubeCreds(userId, credentialId);
    if (!creds?.accessToken) {
      return { success: false, error: 'The approved YouTube channel is no longer connected.', errorCode: 'YOUTUBE_NOT_CONNECTED' };
    }
    await ensureYouTubeAccessToken(creds);
    const { google } = await import('googleapis');
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: creds.accessToken });
    const response = await google.youtube({ version: 'v3', auth: oauth2 }).videos.list({
      part: ['id'],
      id: [videoId],
    });
    const exists = Boolean(response.data.items?.[0]?.id);
    return { success: true, exists, postUrl: exists ? `https://youtu.be/${videoId}` : undefined };
  } catch (error) {
    return { success: false, ...classifyYouTubeError(error) };
  }
}

/** Delete a credential-bound YouTube upload. A provider 404 is idempotent success. */
export async function deleteYouTubeVideo(
  userId: number,
  credentialId: number,
  videoId: string,
): Promise<YouTubeRemoteVideoResult> {
  try {
    const creds = await loadYouTubeCreds(userId, credentialId);
    if (!creds?.accessToken) {
      return { success: false, error: 'The approved YouTube channel is no longer connected.', errorCode: 'YOUTUBE_NOT_CONNECTED' };
    }
    await ensureYouTubeAccessToken(creds);
    const { google } = await import('googleapis');
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: creds.accessToken });
    await google.youtube({ version: 'v3', auth: oauth2 }).videos.delete({ id: videoId });
    return { success: true, exists: false };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'code' in error
      ? Number((error as { code?: unknown }).code)
      : undefined;
    if (status === 404) return { success: true, exists: false };
    return { success: false, ...classifyYouTubeError(error) };
  }
}
