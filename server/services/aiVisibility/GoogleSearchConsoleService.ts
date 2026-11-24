import type { Request, Response } from 'express';
import { beginOAuthBrowserFlow, oauthConfigurationHash } from '../OAuthBrowserFlowService.js';
import { rememberOAuthBusinessState } from '../../tenancy/oauthBusinessScope.js';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../models/db.js';
import {
  aiVisibilityGscConnectionsTable,
  aiVisibilityGscQueryPagesTable,
  aiVisibilityGscSnapshotsTable,
  aiVisibilityProjectsTable,
  type GscPropertyAccess,
} from '../../models/aiVisibility/schema.js';
import { getActiveAdminCredential } from '../../models/adminApiCredentials/functions.js';
import { getCredential, saveCredential } from '../credentialService.js';
import { getIntegrationOAuthCallbackUrl } from '../../utils/integrationUrls.js';
import { logger } from '../../utils/logger.js';

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || '';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
const QUERY_ROW_LIMIT = 5_000;

export interface GscOAuthState {
  userId: number;
  projectId: number;
  nonce: string;
  ts: number;
}

interface GscApiRow {
  keys?: unknown[];
  clicks?: unknown;
  impressions?: unknown;
  ctr?: unknown;
  position?: unknown;
}

interface NormalizedGscRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class GscIntegrationError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public code = 'GSC_ERROR',
  ) {
    super(message);
    this.name = 'GscIntegrationError';
  }
}

export function signGscOAuthState(
  input: Omit<GscOAuthState, 'nonce' | 'ts'> & Partial<Pick<GscOAuthState, 'nonce' | 'ts'>>,
  secret = OAUTH_STATE_SECRET,
): string {
  if (!secret)
    throw new GscIntegrationError('OAuth signing is not configured.', 503, 'OAUTH_NOT_CONFIGURED');
  const payload: GscOAuthState = {
    userId: input.userId,
    projectId: input.projectId,
    nonce: input.nonce || crypto.randomBytes(16).toString('hex'),
    ts: input.ts || Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyGscOAuthState(
  value: string,
  secret = OAUTH_STATE_SECRET,
  now = Date.now(),
): GscOAuthState | null {
  if (!secret) return null;
  try {
    const [encoded, signature] = value.split('.');
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    )
      return null;
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<GscOAuthState>;
    if (
      !Number.isInteger(payload.userId) ||
      !Number.isInteger(payload.projectId) ||
      !payload.nonce ||
      !payload.ts
    )
      return null;
    if (now < payload.ts || now - payload.ts > OAUTH_STATE_MAX_AGE_MS) return null;
    return payload as GscOAuthState;
  } catch {
    return null;
  }
}

function propertyHostname(siteUrl: string): string | null {
  try {
    if (siteUrl.startsWith('sc-domain:'))
      return siteUrl
        .slice('sc-domain:'.length)
        .replace(/^www\./, '')
        .toLowerCase();
    return new URL(siteUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function matchGscProperty(
  projectDomain: string,
  properties: GscPropertyAccess[],
): GscPropertyAccess | null {
  const hostname = propertyHostname(projectDomain);
  if (!hostname) return null;
  const matching = properties.filter((item) => propertyHostname(item.siteUrl) === hostname);
  return (
    matching.find((item) => item.siteUrl.startsWith('sc-domain:')) ||
    matching.find((item) => item.siteUrl.startsWith('https://')) ||
    matching[0] ||
    null
  );
}

export function normalizeGscRows(rows: GscApiRow[] | undefined): NormalizedGscRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const query = String(row.keys?.[0] || '').trim();
    const page = String(row.keys?.[1] || '').trim();
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    const ctr = Number(row.ctr);
    const position = Number(row.position);
    if (!query || !page || ![clicks, impressions, ctr, position].every(Number.isFinite)) return [];
    if (clicks < 0 || impressions < 0 || ctr < 0 || ctr > 1 || position < 0) return [];
    return [{ query, page, clicks, impressions, ctr, position }];
  });
}

export function calculateGscOpportunities(rows: NormalizedGscRow[]) {
  return rows
    .filter(
      (row) => row.impressions >= 50 && row.position >= 4 && row.position <= 20 && row.ctr < 0.05,
    )
    .map((row) => {
      const potentialClicks = Math.max(0, Math.round(row.impressions * (0.05 - row.ctr)));
      const priority =
        row.impressions >= 500 || (row.position <= 10 && row.impressions >= 200)
          ? 'high'
          : 'medium';
      return {
        ...row,
        priority,
        potentialClicks,
        reason:
          row.position <= 10
            ? 'This query already ranks on page one but receives fewer clicks than the 5% review threshold.'
            : 'This query has meaningful impressions and ranks close enough to page one to justify an on-page review.',
      };
    })
    .sort((a, b) => b.potentialClicks - a.potentialClicks || b.impressions - a.impressions);
}

function pacificDate(daysAgo: number, now = new Date()): string {
  const shifted = new Date(now.getTime() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

function safeProviderMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as {
    error?: { message?: unknown } | string;
    error_description?: unknown;
  };
  if (typeof record.error_description === 'string') return record.error_description.slice(0, 500);
  if (typeof record.error === 'string') return record.error.slice(0, 500);
  if (record.error && typeof record.error === 'object' && typeof record.error.message === 'string')
    return record.error.message.slice(0, 500);
  return fallback;
}

export class GoogleSearchConsoleService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async project(userId: number, projectId: number) {
    const [project] = await db
      .select()
      .from(aiVisibilityProjectsTable)
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, projectId),
          eq(aiVisibilityProjectsTable.userId, userId),
          eq(aiVisibilityProjectsTable.status, 'active'),
        ),
      )
      .limit(1);
    if (!project)
      throw new GscIntegrationError('AI Visibility project not found.', 404, 'PROJECT_NOT_FOUND');
    return project;
  }

  private async adminOAuthCredential() {
    const credential = await getActiveAdminCredential('gmail_oauth');
    if (!credential?.apiKey || !credential.apiSecret) {
      throw new GscIntegrationError(
        'Google OAuth is not configured by an administrator.',
        503,
        'GOOGLE_OAUTH_NOT_CONFIGURED',
      );
    }
    return { clientId: credential.apiKey, clientSecret: credential.apiSecret };
  }

  async authorizationUrl(userId: number, projectId: number, req: Request, res: Response) {
    await this.project(userId, projectId);
    const admin = await this.adminOAuthCredential();
    const state = await rememberOAuthBusinessState(signGscOAuthState({ userId, projectId }));
    const redirectUri = getIntegrationOAuthCallbackUrl('googleSearchConsole');
    const browser = await beginOAuthBrowserFlow(req,res,'google_search_console',state,redirectUri,[admin.clientId,admin.clientSecret,redirectUri],true);
    const params = new URLSearchParams({
      code_challenge: browser.codeChallenge!, code_challenge_method: 'S256',
      client_id: admin.clientId,
      redirect_uri: getIntegrationOAuthCallbackUrl('googleSearchConsole'),
      response_type: 'code',
      scope: GSC_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    };
  }

  private async tokenFromCode(code: string, flow: { codeVerifier?: string; configHash: string }) {
    const admin = await this.adminOAuthCredential();
    if (!flow.codeVerifier || flow.configHash !== oauthConfigurationHash([admin.clientId,admin.clientSecret,getIntegrationOAuthCallbackUrl('googleSearchConsole')])) throw new GscIntegrationError('Google sign-in settings changed. Start again.',409,'OAUTH_CONFIGURATION_CHANGED');
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, code_verifier: flow.codeVerifier,
        client_id: admin.clientId,
        client_secret: admin.clientSecret,
        redirect_uri: getIntegrationOAuthCallbackUrl('googleSearchConsole'),
        grant_type: 'authorization_code',
      }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw new GscIntegrationError(
        safeProviderMessage(payload, 'Google authorization could not be completed.'),
        502,
        'TOKEN_EXCHANGE_FAILED',
      );
    }
    return { admin, payload, accessToken: payload.access_token };
  }

  private async listProperties(accessToken: string): Promise<GscPropertyAccess[]> {
    const response = await this.fetchImpl('https://www.googleapis.com/webmasters/v3/sites', {
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json()) as {
      siteEntry?: Array<{ siteUrl?: unknown; permissionLevel?: unknown }>;
      error?: unknown;
    };
    if (!response.ok)
      throw new GscIntegrationError(
        safeProviderMessage(payload, 'Search Console properties could not be loaded.'),
        502,
        'PROPERTY_LIST_FAILED',
      );
    return (payload.siteEntry || []).flatMap((entry) => {
      if (typeof entry.siteUrl !== 'string' || typeof entry.permissionLevel !== 'string') return [];
      return [{ siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel }];
    });
  }

  async completeOAuth(code: string, state: string, flow: { codeVerifier?: string; configHash: string }) {
    const stateData = verifyGscOAuthState(state);
    if (!stateData)
      throw new GscIntegrationError(
        'Google authorization state is invalid or expired.',
        400,
        'INVALID_OAUTH_STATE',
      );
    const project = await this.project(stateData.userId, stateData.projectId);
    const { admin, payload, accessToken } = await this.tokenFromCode(code,flow);
    const refreshToken =
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : undefined;
    if (!refreshToken)
      throw new GscIntegrationError(
        'Google did not return an offline access token. Revoke the previous grant and connect again.',
        502,
        'REFRESH_TOKEN_MISSING',
      );
    const properties = await this.listProperties(accessToken);
    const selected = matchGscProperty(project.domain, properties);
    const saved = await saveCredential(
      stateData.userId,
      'google_search_console',
      admin.clientId,
      undefined,
      {
        refreshToken,
        scope: GSC_SCOPE,
        connectedAt: new Date().toISOString(),
      },
    );
    if (!saved)
      throw new GscIntegrationError(
        'Search Console credentials could not be stored.',
        500,
        'CREDENTIAL_SAVE_FAILED',
      );
    const credential = await getCredential(stateData.userId, 'google_search_console');
    const values = {
      userId: stateData.userId,
      projectId: stateData.projectId,
      credentialId: credential?.id || null,
      selectedProperty: selected?.siteUrl || null,
      permissionLevel: selected?.permissionLevel || null,
      availableProperties: properties,
      status: selected ? 'connected' : 'property_required',
      lastSyncError: null,
      updatedAt: new Date(),
    };
    await db.insert(aiVisibilityGscConnectionsTable).values(values).onConflictDoUpdate({
      target: aiVisibilityGscConnectionsTable.projectId,
      set: values,
    });
    return {
      projectId: project.id,
      selectedProperty: selected?.siteUrl || null,
      propertyCount: properties.length,
    };
  }

  private async accessToken(userId: number) {
    const credential = await getCredential(userId, 'google_search_console');
    const refreshToken = credential?.config?.refreshToken;
    if (!refreshToken)
      throw new GscIntegrationError('Search Console is not connected.', 409, 'NOT_CONNECTED');
    const admin = await this.adminOAuthCredential();
    if (credential.apiKey !== admin.clientId) throw new GscIntegrationError('Google sign-in settings changed. Connect Search Console again.',409,'OAUTH_CLIENT_CHANGED');
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: admin.clientId,
        client_secret: admin.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw new GscIntegrationError(
        safeProviderMessage(payload, 'Search Console authorization expired. Connect again.'),
        502,
        'TOKEN_REFRESH_FAILED',
      );
    }
    return payload.access_token;
  }

  async selectProperty(userId: number, projectId: number, propertyUri: string) {
    await this.project(userId, projectId);
    const [connection] = await db
      .select()
      .from(aiVisibilityGscConnectionsTable)
      .where(
        and(
          eq(aiVisibilityGscConnectionsTable.projectId, projectId),
          eq(aiVisibilityGscConnectionsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!connection)
      throw new GscIntegrationError('Search Console is not connected.', 409, 'NOT_CONNECTED');
    const property = (connection.availableProperties as GscPropertyAccess[]).find(
      (item: GscPropertyAccess) => item.siteUrl === propertyUri,
    );
    if (!property)
      throw new GscIntegrationError(
        'Choose a property returned by the connected Search Console account.',
        400,
        'INVALID_PROPERTY',
      );
    const [updated] = await db
      .update(aiVisibilityGscConnectionsTable)
      .set({
        selectedProperty: property.siteUrl,
        permissionLevel: property.permissionLevel,
        status: 'connected',
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityGscConnectionsTable.id, connection.id),
          eq(aiVisibilityGscConnectionsTable.userId, userId),
        ),
      )
      .returning();
    return updated;
  }

  async sync(
    userId: number,
    projectId: number,
    range?: { startDate: string; endDate: string; compare?: boolean },
  ) {
    const startDate = range?.startDate || pacificDate(29);
    const endDate = range?.endDate || pacificDate(2);
    const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
    if (!Number.isFinite(days) || days < 1 || days > 90 || endDate > pacificDate(2))
      throw new GscIntegrationError(
        'Choose a date range of 1–90 days ending at least two days ago.',
        400,
        'INVALID_DATE_RANGE',
      );
    let comparisonSnapshotId: number | null = null;
    if (range?.compare) {
      const previousEnd = new Date(Date.parse(startDate) - 86400000).toISOString().slice(0, 10);
      const previousStart = new Date(Date.parse(startDate) - days * 86400000)
        .toISOString()
        .slice(0, 10);
      const previous = await this.syncPeriod(userId, projectId, previousStart, previousEnd);
      comparisonSnapshotId = previous.snapshot.id;
    }
    return {
      ...(await this.syncPeriod(userId, projectId, startDate, endDate)),
      comparisonSnapshotId,
    };
  }

  private async syncPeriod(userId: number, projectId: number, startDate: string, endDate: string) {
    await this.project(userId, projectId);
    const [connection] = await db
      .select()
      .from(aiVisibilityGscConnectionsTable)
      .where(
        and(
          eq(aiVisibilityGscConnectionsTable.projectId, projectId),
          eq(aiVisibilityGscConnectionsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!connection?.selectedProperty)
      throw new GscIntegrationError(
        'Select a Search Console property before syncing.',
        409,
        'PROPERTY_REQUIRED',
      );
    try {
      const token = await this.accessToken(userId);
      const response = await this.fetchImpl(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.selectedProperty)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            startDate,
            endDate,
            dimensions: ['query', 'page'],
            type: 'web',
            dataState: 'final',
            rowLimit: QUERY_ROW_LIMIT,
          }),
        },
      );
      const payload = (await response.json()) as {
        rows?: GscApiRow[];
        responseAggregationType?: string;
        error?: unknown;
      };
      if (!response.ok)
        throw new GscIntegrationError(
          safeProviderMessage(payload, 'Search Console data could not be synchronized.'),
          502,
          'SYNC_FAILED',
        );
      const rows = normalizeGscRows(payload.rows);
      const fingerprint = crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            property: connection.selectedProperty,
            startDate,
            endDate,
            rows,
          }),
        )
        .digest('hex');
      const snapshot = await db.transaction(async (tx: typeof db) => {
        const [created] = await tx
          .insert(aiVisibilityGscSnapshotsTable)
          .values({
            userId,
            projectId,
            connectionId: connection.id,
            propertyUri: connection.selectedProperty!,
            startDate,
            endDate,
            rowCount: rows.length,
            inputFingerprint: fingerprint,
            responseAggregationType: payload.responseAggregationType || null,
          })
          .returning();
        if (rows.length)
          await tx.insert(aiVisibilityGscQueryPagesTable).values(
            rows.map((row) => ({
              snapshotId: created.id,
              userId,
              projectId,
              query: row.query,
              page: row.page,
              clicks: row.clicks.toFixed(4),
              impressions: row.impressions.toFixed(4),
              ctr: row.ctr.toFixed(8),
              position: row.position.toFixed(4),
            })),
          );
        return created;
      });
      await db
        .update(aiVisibilityGscConnectionsTable)
        .set({
          status: 'connected',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityGscConnectionsTable.id, connection.id),
            eq(aiVisibilityGscConnectionsTable.userId, userId),
          ),
        );
      return { snapshot, rowCount: rows.length };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Search Console synchronization failed.';
      await db
        .update(aiVisibilityGscConnectionsTable)
        .set({
          status: 'sync_failed',
          lastSyncError: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityGscConnectionsTable.id, connection.id),
            eq(aiVisibilityGscConnectionsTable.userId, userId),
          ),
        );
      throw error instanceof GscIntegrationError
        ? error
        : new GscIntegrationError(message, 502, 'SYNC_FAILED');
    }
  }

  async overview(userId: number, projectId: number, snapshotId?: number) {
    await this.project(userId, projectId);
    const [connection] = await db
      .select()
      .from(aiVisibilityGscConnectionsTable)
      .where(
        and(
          eq(aiVisibilityGscConnectionsTable.projectId, projectId),
          eq(aiVisibilityGscConnectionsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!connection)
      return {
        connected: false,
        available: false,
        unavailableReason:
          'Connect Google Search Console to load verified query and page opportunities.',
        connection: null,
        snapshot: null,
        summary: null,
        opportunities: [],
      };
    const snapshots = await db
      .select()
      .from(aiVisibilityGscSnapshotsTable)
      .where(
        and(
          eq(aiVisibilityGscSnapshotsTable.projectId, projectId),
          eq(aiVisibilityGscSnapshotsTable.userId, userId),
          connection.selectedProperty
            ? eq(aiVisibilityGscSnapshotsTable.propertyUri, connection.selectedProperty)
            : undefined,
        ),
      )
      .orderBy(
        desc(aiVisibilityGscSnapshotsTable.endDate),
        desc(aiVisibilityGscSnapshotsTable.createdAt),
      )
      .limit(100);
    const snapshot = snapshotId
      ? snapshots.find((item: { id: number }) => item.id === snapshotId)
      : snapshots[0];
    if (!snapshot)
      return {
        connected: true,
        available: false,
        unavailableReason: connection.selectedProperty
          ? 'Sync Search Console to load verified query and page opportunities.'
          : 'Choose a Search Console property before syncing.',
        connection,
        snapshot: null,
        summary: null,
        opportunities: [],
      };
    const storedRows = await db
      .select()
      .from(aiVisibilityGscQueryPagesTable)
      .where(
        and(
          eq(aiVisibilityGscQueryPagesTable.snapshotId, snapshot.id),
          eq(aiVisibilityGscQueryPagesTable.userId, userId),
          eq(aiVisibilityGscQueryPagesTable.projectId, projectId),
        ),
      );
    const rows: NormalizedGscRow[] = storedRows.map(
      (row: typeof aiVisibilityGscQueryPagesTable.$inferSelect) => ({
        query: row.query,
        page: row.page,
        clicks: Number(row.clicks),
        impressions: Number(row.impressions),
        ctr: Number(row.ctr),
        position: Number(row.position),
      }),
    );
    const duration = Date.parse(snapshot.endDate) - Date.parse(snapshot.startDate) + 86400000;
    const previousEnd = new Date(Date.parse(snapshot.startDate) - 86400000)
      .toISOString()
      .slice(0, 10);
    const previousStart = new Date(Date.parse(snapshot.startDate) - duration)
      .toISOString()
      .slice(0, 10);
    const previousSnapshot = snapshots.find(
      (item: typeof aiVisibilityGscSnapshotsTable.$inferSelect) =>
        item.startDate === previousStart && item.endDate === previousEnd,
    );
    const previousRows = previousSnapshot
      ? await db
          .select()
          .from(aiVisibilityGscQueryPagesTable)
          .where(
            and(
              eq(aiVisibilityGscQueryPagesTable.snapshotId, previousSnapshot.id),
              eq(aiVisibilityGscQueryPagesTable.userId, userId),
            ),
          )
      : [];
    const comparison = previousSnapshot
      ? {
          snapshot: previousSnapshot,
          clicks: previousRows.reduce(
            (sum: number, row: { clicks: string }) => sum + Number(row.clicks),
            0,
          ),
          impressions: previousRows.reduce(
            (sum: number, row: { impressions: string }) => sum + Number(row.impressions),
            0,
          ),
        }
      : null;
    const totalClicks = rows.reduce((sum: number, row: NormalizedGscRow) => sum + row.clicks, 0);
    const totalImpressions = rows.reduce(
      (sum: number, row: NormalizedGscRow) => sum + row.impressions,
      0,
    );
    const weightedPosition = totalImpressions
      ? rows.reduce(
          (sum: number, row: NormalizedGscRow) => sum + row.position * row.impressions,
          0,
        ) / totalImpressions
      : 0;
    return {
      connected: true,
      available: true,
      unavailableReason: null,
      connection,
      snapshot,
      summary: {
        rowCount: rows.length,
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: totalImpressions ? totalClicks / totalImpressions : 0,
        position: weightedPosition,
      },
      opportunities: calculateGscOpportunities(rows),
      rows,
      snapshots,
      comparison,
    };
  }

  async disconnect(userId: number, projectId: number) {
    await this.project(userId, projectId);
    const [deleted] = await db
      .delete(aiVisibilityGscConnectionsTable)
      .where(
        and(
          eq(aiVisibilityGscConnectionsTable.projectId, projectId),
          eq(aiVisibilityGscConnectionsTable.userId, userId),
        ),
      )
      .returning({ id: aiVisibilityGscConnectionsTable.id });
    return { disconnected: Boolean(deleted) };
  }

  callbackRedirect(result: { projectId: number; selectedProperty: string | null }) {
    const params = new URLSearchParams({ gsc: 'connected' });
    if (!result.selectedProperty) params.set('property', 'required');
    return `${FRONTEND_URL}/dashboard/ai-visibility/websites/${result.projectId}/seo?${params.toString()}`;
  }

  callbackErrorRedirect(error: unknown, projectId?: number) {
    const message = error instanceof Error ? error.message : 'Google authorization failed.';
    const params = new URLSearchParams({
      gsc: 'error',
      message: message.slice(0, 300),
    });
    const path = projectId ? `/websites/${projectId}/seo` : '';
    return `${FRONTEND_URL}/dashboard/ai-visibility${path}?${params.toString()}`;
  }
}

export const googleSearchConsoleService = new GoogleSearchConsoleService();

if (!OAUTH_STATE_SECRET)
  logger.error('[GoogleSearchConsole] OAUTH_STATE_SECRET / JWT_SECRET must be set');
