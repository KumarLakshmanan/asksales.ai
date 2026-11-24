import { assertRecipientNotSuppressed, RecipientSuppressedError } from './outreach/RecipientSuppressionService.js';
import { metaRetryable, providerRetryAfter, WHATSAPP_APP_RATE_LIMIT } from './outreach/providerRetry.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WhatsApp Cloud API Service
 *
 * Single entry point for all outbound WhatsApp Business API calls. Handles:
 *  - Credential resolution from BOTH `channel_credentials` (OAuth) AND
 *    `api_credentials` (manual entry via CredentialService).
 *  - Token refresh for OAuth long-lived tokens (skipped for manual creds).
 *  - Per-tenant + per-phone-number rate limiting via Redis.
 *  - Text, template, image, document, and reaction message types.
 *  - Reply context (`context.message_id`) so replies thread on the
 *    recipient's WhatsApp client.
 *
 * Credential resolution: rate limit only counts AFTER credentials resolve, so
 * misconfigured tenants don't burn the per-minute budget.
 */

import { logger } from '../utils/logger.js';
import { createHash } from 'node:crypto';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { LRUCache } from '../utils/lruCache.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure } from './assistants/CustomerDeliveryGate.js';
import { db } from '../models/db.js';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';
import { eq, and, sql } from 'drizzle-orm';
import { getRedisConnection } from '../infrastructure/redis.js';
import { readResponseBuffer } from '../utils/safeRemoteFetch.js';
import { MAX_OUTREACH_ATTACHMENT_SIZE } from '../utils/outreachAttachmentPolicy.js';
import type { OutreachTemplate } from '../../shared/outreachCompose.js';
import {
  decryptChannelCredentialSecret,
  decryptChannelCredentialSession,
  encryptChannelCredentialSecret,
  encryptChannelCredentialSession,
  getChannelCredentialEncryptionKeyId,
} from '../utils/channelCredentialSecrets.js';
import {
  buildWhatsAppInteractive,
  type SupportChoiceManifest,
} from './agents/orchestration/SupportChoiceDelivery.js';

// ── Types ──────────────────────────────────────────────────────────────────
/** 'missing': Meta has no payment method, so paid templates fail; 'billed_by_asksales': our credit line pays. */
export type WhatsAppPaymentMethodStatus = 'present' | 'missing' | 'unknown' | 'billed_by_asksales';

export interface ResolvedWhatsAppCreds {
  source: 'channel_credentials' | 'api_credentials';
  credId: number;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  apiVersion: string;
  isManual: boolean;
  expiresAt?: string | null;
  sessionData?: any;
}

export interface SendTextOptions {
  userId: number;
  phoneNumberId?: string;     // optional override; defaults to user's configured number
  to: string;                 // recipient phone (E.164 digits, no +)
  text: string;
  contextMessageId?: string;  // reply-to wamid for threading on the recipient's app
}

export interface SendChoiceOptions extends SendTextOptions {
  choice: SupportChoiceManifest;
}

export interface SendCtaUrlOptions extends SendTextOptions {
  url: string;
  title: string;
  allowTextFallback?: boolean;
}

export interface SendTemplateOptions {
  userId: number;
  phoneNumberId?: string;
  to: string;
  templateName: string;
  language: string;           // e.g. 'en_US'
  components?: any[];         // Meta template components (header/body/buttons)
}

export interface SendMediaOptions {
  userId: number;
  phoneNumberId?: string;
  to: string;
  mediaType: 'image' | 'document' | 'video' | 'audio';
  mediaUrl?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
}

export interface UploadMediaOptions {
  userId: number;
  phoneNumberId?: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  /** A header for a Meta-approved template; see CustomerDeliveryIdentity.approvedTemplate. */
  approvedTemplate?: boolean;
}

export class WhatsAppApiService {
  private readonly selectionCatalog = new LRUCache<OutreachTemplate[]>({ maxSize: 25, defaultTTL: 60_000 });
  private readonly selectionCatalogReads = new Map<string, Promise<OutreachTemplate[]>>();

  /** Read Meta's approved catalog for the exact number's WABA, including language variants. */
  async listApprovedTemplates(userId: number, phoneNumberId: string): Promise<OutreachTemplate[]> {
    const creds = await this.resolveAndValidate(userId, phoneNumberId, false, true);
    if (!creds.businessAccountId) throw new Error('Reconnect this WhatsApp number with its Business Account.');
    const token = await this.ensureTokenValidity(creds);
    return this.readApprovedTemplateCatalog(creds, token);
  }

  /** Browsing uses a short catalog snapshot; dispatch validation always uses the fresh method above. */
  async listTemplatesForSelection(userId: number, phoneNumberId: string): Promise<OutreachTemplate[]> {
    const scope = currentBusinessScope();
    if (!scope || scope.userId !== userId) throw new Error('Select the verified business that owns this WhatsApp account.');
    const creds = await this.resolveCreds(userId, phoneNumberId);
    if (!creds?.accessToken || creds.phoneNumberId !== phoneNumberId) throw new Error('Connect this WhatsApp number before choosing a template.');
    if (!creds.businessAccountId) throw new Error('Reconnect this WhatsApp number with its Business Account.');
    if (creds.expiresAt && new Date(creds.expiresAt).getTime() <= Date.now()) throw new Error('Reconnect this WhatsApp number to refresh its authorization.');
    const key = JSON.stringify([userId, scope.businessProfileId, scope.actorUserId ?? userId,
      creds.source, creds.credId, phoneNumberId, creds.businessAccountId, creds.apiVersion,
      createHash('sha256').update(creds.accessToken).digest('hex')]);
    const cached = this.selectionCatalog.get(key);
    if (cached) return structuredClone(cached);
    let pending = this.selectionCatalogReads.get(key);
    if (!pending) {
      const deadline = AbortSignal.timeout(15_000);
      pending = (async () => {
        const startedAt = Date.now();
        const token = await this.ensureTokenValidity(creds);
        const templates = await this.readApprovedTemplateCatalog(creds, token, deadline);
        this.selectionCatalog.set(key, templates);
        logger.info({ phoneNumberId, templateCount: templates.length, durationMs: Date.now() - startedAt }, '[WhatsAppApiService] Refreshed template selection catalog');
        return templates;
      })();
      this.selectionCatalogReads.set(key, pending);
    }
    try {
      return structuredClone(await pending);
    } finally {
      if (this.selectionCatalogReads.get(key) === pending) this.selectionCatalogReads.delete(key);
    }
  }

  private async readApprovedTemplateCatalog(creds: ResolvedWhatsAppCreds, token: string, deadline?: AbortSignal): Promise<OutreachTemplate[]> {
    const businessAccountId = creds.businessAccountId;
    if (!businessAccountId) throw new Error('Reconnect this WhatsApp number with its Business Account.');
    const templates: OutreachTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ fields: 'id,name,status,language,components', limit: '100', ...(after ? { after } : {}) });
      const response = await fetch(`https://graph.facebook.com/${creds.apiVersion}/${encodeURIComponent(businessAccountId)}/message_templates?${query}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: deadline ?? AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { data?: Array<{ id: string; name: string; language: string; status: string; components?: Array<{ type: string; format?: string; text?: string; buttons?: Array<{ type: string; text: string; url?: string }> }> }>; error?: { message?: string }; paging?: { next?: string; cursors?: { after?: string } } };
      if (!response.ok || !Array.isArray(body.data)) throw new Error(body.error?.message || 'Approved WhatsApp templates could not be loaded.');
      for (const template of body.data) {
        if (template.status !== 'APPROVED') continue;
        const header = template.components?.find(component => component.type === 'HEADER');
        const message = template.components?.find(component => component.type === 'BODY');
        if (!message?.text || (header?.format && !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format))) continue;
        templates.push({ id: template.id, name: template.name, language: template.language, body: message.text,
          header: header?.text, headerType: header?.format, footer: template.components?.find(component => component.type === 'FOOTER')?.text,
          buttons: template.components?.find(component => component.type === 'BUTTONS')?.buttons,
        });
      }
      if (!body.paging?.next || !body.paging.cursors?.after) return templates;
      after = body.paging.cursors.after;
    }
    throw new Error('The WhatsApp template catalog is too large to load. Try again after organizing templates in WhatsApp Manager.');
  }

  async recordReadiness(
    creds: ResolvedWhatsAppCreds,
    outcome: { ok: boolean; code?: number | string; subcode?: number | string },
  ): Promise<void> {
    if (creds.source !== 'channel_credentials' || creds.credId <= 0) return;
    const errorCode = outcome.ok
      ? null
      : `meta_${String(outcome.code || 'unknown')}_${String(outcome.subcode || '0')}`.slice(0, 64);
    try {
      await db.update(channelCredentialsTable).set({
        providerVerifiedAt: outcome.ok ? new Date() : undefined,
        lastReadinessCheckAt: new Date(),
        // A successful identity/delivery probe clears only transient Graph
        // request errors. It must not erase a stronger account-level finding
        // such as WABA_HEALTH, which can gate proactive/template traffic while
        // customer-service replies remain available.
        readinessErrorCode: outcome.ok
          ? sql`CASE
              WHEN ${channelCredentialsTable.readinessErrorCode} LIKE 'meta\_%' ESCAPE '\\' THEN NULL
              ELSE ${channelCredentialsTable.readinessErrorCode}
            END`
          : errorCode,
        updatedAt: new Date(),
      }).where(eq(channelCredentialsTable.id, creds.credId));
    } catch (error) {
      logger.warn({ err: error, credId: creds.credId }, '[WhatsAppApiService] Could not persist provider readiness');
    }
  }

  /**
   * Whether Meta has a payment method on this WhatsApp Business Account.
   * On customer billing Meta charges the customer's own card; without one,
   * marketing, utility and authentication templates fail. The result is kept
   * on the connection so the WhatsApp page can show it.
   */
  async checkPaymentMethod(creds: ResolvedWhatsAppCreds): Promise<WhatsAppPaymentMethodStatus> {
    let status: WhatsAppPaymentMethodStatus = 'unknown';
    if (creds.businessAccountId) {
      try {
        const token = await this.ensureTokenValidity(creds);
        const response = await fetch(
          `https://graph.facebook.com/${creds.apiVersion}/${encodeURIComponent(creds.businessAccountId)}?fields=primary_funding_id`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        );
        const data = await response.json() as { primary_funding_id?: string };
        if (response.ok) status = data.primary_funding_id ? 'present' : 'missing';
      } catch (error) {
        logger.warn({ err: error, credId: creds.credId }, '[WhatsAppApiService] Could not check the payment method');
      }
    }
    if (creds.source === 'channel_credentials' && creds.credId > 0) {
      try {
        await db.execute(sql`UPDATE channel_credentials
          SET session_data = COALESCE(session_data, '{}'::jsonb) || jsonb_build_object('paymentMethod',
            jsonb_build_object('status', ${status}::text, 'checkedAt', ${new Date().toISOString()}::text)),
            updated_at = NOW()
          WHERE id = ${creds.credId}`);
      } catch (error) {
        logger.warn({ err: error, credId: creds.credId }, '[WhatsAppApiService] Could not save the payment method status');
      }
    }
    return status;
  }

  // ── Credential resolution ────────────────────────────────────────────────
  /**
   * Resolve WhatsApp credentials for a user from either channel_credentials
   * (OAuth) or api_credentials (manual). Returns null if not found.
   */
  async resolveCreds(userId: number, phoneNumberIdHint?: string): Promise<ResolvedWhatsAppCreds | null> {
    // Prefer channel_credentials (OAuth or dual-saved manual).
    const ccRows = await db.select().from(channelCredentialsTable).where(
      and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'whatsapp'),
        eq(channelCredentialsTable.isActive, true)
      )
    ).limit(1);

    let cc = ccRows[0];

    // If a specific phoneNumberId was requested, prefer the matching row.
    if (phoneNumberIdHint && (!cc || cc.accountIdentifier !== phoneNumberIdHint)) {
      const all = await db.select().from(channelCredentialsTable).where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'whatsapp'),
          eq(channelCredentialsTable.accountIdentifier, phoneNumberIdHint),
          eq(channelCredentialsTable.isActive, true),
        )
      );
      // An explicit account is a binding, not a preference. Never retain the
      // first account when the requested phone number was removed.
      cc = all[0];
    }

    if (cc && (cc.apiKey || (cc as any).accessToken)) {
      const sd = decryptChannelCredentialSession((cc.sessionData as any) || {}) as any;
      return {
        source: 'channel_credentials',
        credId: cc.id,
        accessToken: decryptChannelCredentialSecret((cc as any).accessToken || cc.apiKey!),
        phoneNumberId: cc.accountIdentifier || sd.phoneNumberId || '',
        businessAccountId: sd.businessAccountId || '',
        apiVersion: sd.apiVersion || (await this.getApiVersion()),
        isManual: cc.credentialType === 'manual' || !!sd.connectedViaManual,
        expiresAt: sd.accessTokenExpiresAt || null,
        sessionData: sd,
      };
    }

    // Fallback: api_credentials (legacy CredentialService path).
    try {
      const { getCredential } = await import('./credentialService.js');
      const apiCred: any = await getCredential(userId, 'whatsapp');
      if (apiCred?.apiKey || apiCred?.config?.accessToken) {
        const cfg = apiCred.config || {};
        if (phoneNumberIdHint && cfg.phoneNumberId !== phoneNumberIdHint) return null;
        return {
          source: 'api_credentials',
          credId: apiCred.id || -1,
          accessToken: apiCred.apiKey || cfg.accessToken,
          phoneNumberId: cfg.phoneNumberId || '',
          businessAccountId: cfg.businessAccountId || '',
          apiVersion: cfg.apiVersion || (await this.getApiVersion()),
          isManual: !!cfg.connectedViaManual,
          expiresAt: cfg.accessTokenExpiresAt || null,
          sessionData: cfg,
        };
      }
    } catch (_err) {
      // ignore
    }
    return null;
  }

  /**
   * Refresh OAuth tokens that expire within 7 days. No-op for manual creds.
   */
  async ensureTokenValidity(creds: ResolvedWhatsAppCreds): Promise<string> {
    if (creds.isManual || creds.source === 'api_credentials') return creds.accessToken;
    if (!creds.expiresAt) return creds.accessToken;

    const expiresAt = new Date(creds.expiresAt).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (expiresAt - now >= sevenDaysMs) return creds.accessToken;

    try {
      const adminCred = await getActiveAdminCredential('meta_app');
      if (!adminCred?.apiKey || !adminCred?.apiSecret) return creds.accessToken;
      const apiVersion = creds.apiVersion;
      const url = `https://graph.facebook.com/${apiVersion}/oauth/access_token`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: adminCred.apiKey,
          client_secret: adminCred.apiSecret,
          fb_exchange_token: creds.accessToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data: any = await resp.json();
      if (data.access_token) {
        const newSession = {
          ...(creds.sessionData || {}),
          // The full object is encrypted immediately before persistence.
          accessToken: data.access_token,
          expiresIn: data.expires_in,
          accessTokenExpiresAt: data.expires_in ? new Date(now + data.expires_in * 1000).toISOString() : null,
        };
        await db.update(channelCredentialsTable)
          .set({
            apiKey: encryptChannelCredentialSecret(data.access_token),
            accessToken: encryptChannelCredentialSecret(data.access_token),
            sessionData: encryptChannelCredentialSession(newSession),
            lastRefreshedAt: new Date(),
            encryptionVersion: 'secrets-manager-v1',
            encryptionKeyId: getChannelCredentialEncryptionKeyId(),
            encryptedAt: new Date(),
          } as any)
          .where(eq(channelCredentialsTable.id, creds.credId));
        logger.info({ credId: creds.credId }, '[WhatsAppApiService] Token refreshed');
        return data.access_token;
      }
    } catch (err: any) {
      logger.error({ err }, '[WhatsAppApiService] Token refresh failed');
    }
    return creds.accessToken;
  }

  // ── Rate limiting ────────────────────────────────────────────────────────
  private async rateLimitCheck(userId: number, phoneNumberId: string): Promise<void> {
    const tenantKey = `wa_limit_tenant:${userId}`;
    const phoneKey = `wa_limit_phone:${userId}:${phoneNumberId}`;
    const redis = getRedisConnection();
    const tenantCount = await redis.incr(tenantKey);
    if (tenantCount === 1) await redis.expire(tenantKey, 60);
    const phoneCount = await redis.incr(phoneKey);
    if (phoneCount === 1) await redis.expire(phoneKey, 60);
    if (tenantCount > 100 || phoneCount > 60) {
      const windows = await Promise.all([
        tenantCount > 100 ? redis.pttl(tenantKey) : 0,
        phoneCount > 60 ? redis.pttl(phoneKey) : 0,
      ]);
      throw Object.assign(new Error('WhatsApp app sending capacity reached. Queued until the rate-limit window resets.'), {
        code: WHATSAPP_APP_RATE_LIMIT,
        retryable: true,
        retryAfterMs: Math.max(...windows.filter((_ttl, index) => index === 0 ? tenantCount > 100 : phoneCount > 60).map(ttl => ttl > 0 ? ttl : 60_000)) + 1000,
        deliveryAttempted: false,
        outcomeUncertain: false,
      });
    }
  }

  // ── Send variants ────────────────────────────────────────────────────────
  async sendText(opts: SendTextOptions): Promise<any> {
    let deliveryAttempted = false;
    try {
      const creds = await this.resolveAndValidate(opts.userId, opts.phoneNumberId);
      const token = await this.ensureTokenValidity(creds);
      const payload: any = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'text',
        text: { body: opts.text, preview_url: false },
      };
      if (opts.contextMessageId) payload.context = { message_id: opts.contextMessageId };
      deliveryAttempted = true;
      return await this.dispatch(creds, token, payload, opts.userId);
    } catch (error: any) {
      if (error && typeof error === 'object') {
        // A structured Meta HTTP rejection is authoritative: the provider did
        // not accept a message, so the outbox may safely classify/retry it.
        error.deliveryAttempted = error.outcomeUncertain === false ? false : (error.deliveryAttempted ?? deliveryAttempted);
      }
      throw error;
    }
  }

  /**
   * Send a provider-native reply-button or list message. If the published
   * choice cannot be represented within WhatsApp's limits, send the canonical
   * numbered fallback instead. The model never supplies this payload.
   */
  async sendChoice(opts: SendChoiceOptions): Promise<any> {
    const interactive = buildWhatsAppInteractive(opts.choice, opts.text);
    if (!interactive) return this.sendText({ ...opts, text: opts.text });
    let deliveryAttempted = false;
    try {
      const creds = await this.resolveAndValidate(opts.userId, opts.phoneNumberId);
      const token = await this.ensureTokenValidity(creds);
      const payload: any = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'interactive',
        interactive,
      };
      if (opts.contextMessageId) payload.context = { message_id: opts.contextMessageId };
      deliveryAttempted = true;
      return await this.dispatch(creds, token, payload, opts.userId);
    } catch (error: any) {
      if (error && typeof error === 'object') {
        error.deliveryAttempted = error.outcomeUncertain === false ? false : (error.deliveryAttempted ?? deliveryAttempted);
      }
      throw error;
    }
  }

  /** Send an owner-approved external URL as a native WhatsApp CTA. The URL is
   * copied verbatim into deterministic provider JSON and is never model-authored. */
  async sendCtaUrl(opts: SendCtaUrlOptions): Promise<any> {
    const parsed = new URL(opts.url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('WhatsApp CTA requires a credential-free HTTPS URL.');
    }
    const title = opts.title.trim().slice(0, 20) || 'Book now';
    let deliveryAttempted = false;
    try {
      const creds = await this.resolveAndValidate(opts.userId, opts.phoneNumberId);
      const token = await this.ensureTokenValidity(creds);
      const payload: any = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: opts.text },
          action: {
            name: 'cta_url',
            parameters: { display_text: title, url: opts.url },
          },
        },
      };
      if (opts.contextMessageId) payload.context = { message_id: opts.contextMessageId };
      deliveryAttempted = true;
      return await this.dispatch(creds, token, payload, opts.userId);
    } catch (error: any) {
      if (error && typeof error === 'object') {
        error.deliveryAttempted = error.outcomeUncertain === false ? false : (error.deliveryAttempted ?? deliveryAttempted);
      }
      // A definitive provider rejection permits a text fallback. Timeouts and
      // uncertain outcomes must never trigger a possible duplicate referral.
      if (opts.allowTextFallback && error?.outcomeUncertain === false && !deliverySetupFailure(error) && !error?.suppressionCheckFailed) {
        logger.info({ userId: opts.userId, code: error?.code }, '[WhatsAppApiService] CTA rejected; using exact text-link fallback');
        return this.sendText(opts);
      }
      throw error;
    }
  }

  async sendTemplate(opts: SendTemplateOptions): Promise<any> {
    let deliveryAttempted = false;
    try {
      const creds = await this.resolveAndValidate(opts.userId, opts.phoneNumberId, false, true);
      const token = await this.ensureTokenValidity(creds);
      // Uploaded IDs are account-scoped; never accept an arbitrary client's ID.
      for (const component of opts.components || []) {
        for (const parameter of component.parameters || []) {
          const media = ['image', 'video', 'document'].includes(parameter.type) ? parameter[parameter.type] : null;
          if (media?.id && await getRedisConnection().get(`wa-template-media:${opts.userId}:${creds.phoneNumberId}:${media.id}`) !== parameter.type) {
            throw Object.assign(new Error('This template upload has expired or belongs to another sending account. Upload it again.'), { outcomeUncertain: false });
          }
        }
      }
      const payload: any = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'template',
        template: {
          name: opts.templateName,
          language: { code: opts.language || 'en_US' },
          ...(opts.components && opts.components.length ? { components: opts.components } : {}),
        },
      };
      deliveryAttempted = true;
      return await this.dispatch(creds, token, payload, opts.userId);
    } catch (error: any) {
      if (error && typeof error === 'object') {
        error.deliveryAttempted = error.outcomeUncertain === false ? false : (error.deliveryAttempted ?? deliveryAttempted);
      }
      throw error;
    }
  }

  async uploadMedia(opts: UploadMediaOptions): Promise<{ id: string }> {
    const creds = await this.resolveAndValidate(opts.userId, opts.phoneNumberId, false, opts.approvedTemplate === true);
    const token = await this.ensureTokenValidity(creds);
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', opts.mimeType);
    form.set('file', new Blob([new Uint8Array(opts.buffer)], { type: opts.mimeType }), opts.fileName);
    const response = await fetch(`https://graph.facebook.com/${creds.apiVersion}/${creds.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok || !data.id) {
      throw new Error(data.error?.message || `WhatsApp media upload failed with HTTP ${response.status}`);
    }
    return { id: data.id };
  }

  async uploadTemplateMedia(opts: UploadMediaOptions & { phoneNumberId: string }): Promise<{ id: string }> {
    const result = await this.uploadMedia({ ...opts, approvedTemplate: true });
    const kind = opts.mimeType.startsWith('image/') ? 'image' : opts.mimeType.startsWith('video/') ? 'video' : 'document';
    await getRedisConnection().set(`wa-template-media:${opts.userId}:${opts.phoneNumberId}:${result.id}`, kind, 'EX', 29 * 86400);
    return result;
  }

  async downloadMedia(userId: number, mediaId: string, phoneNumberId?: string, options: { maxBytes?: number } = {}): Promise<{
    buffer: Buffer;
    mimeType: string;
    fileSize: number;
  }> {
    const maxBytes = options.maxBytes ?? MAX_OUTREACH_ATTACHMENT_SIZE;
    const tooLarge = `WhatsApp attachment exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB application limit.`;
    const creds = await this.resolveAndValidate(userId, phoneNumberId, true);
    const token = await this.ensureTokenValidity(creds);
    const metadataResponse = await fetch(`https://graph.facebook.com/${creds.apiVersion}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const metadata = await metadataResponse.json() as { url?: string; mime_type?: string; file_size?: number; error?: { message?: string } };
    if (!metadataResponse.ok || !metadata.url) throw new Error(metadata.error?.message || 'WhatsApp media metadata could not be loaded.');
    if (Number(metadata.file_size || 0) > maxBytes) throw new Error(tooLarge);
    const fileResponse = await fetch(metadata.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileResponse.ok) throw new Error(`WhatsApp media download failed with HTTP ${fileResponse.status}`);
    const contentLength = Number(fileResponse.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error(tooLarge);
    const buffer = await readResponseBuffer(fileResponse, maxBytes);
    return {
      buffer,
      mimeType: metadata.mime_type || fileResponse.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
      fileSize: buffer.length,
    };
  }

  async sendMedia(opts: SendMediaOptions): Promise<any> {
    let deliveryAttempted = false;
    try {
      const creds = await this.resolveAndValidate(opts.userId, opts.phoneNumberId);
      const token = await this.ensureTokenValidity(creds);
      if (!opts.mediaUrl && !opts.mediaId) {
        throw new Error('sendMedia requires either mediaUrl or mediaId');
      }
      const mediaPayload: any = {};
      if (opts.mediaId) mediaPayload.id = opts.mediaId;
      else if (opts.mediaUrl) mediaPayload.link = opts.mediaUrl;
      if (opts.caption && opts.mediaType !== 'audio') mediaPayload.caption = opts.caption;
      if (opts.filename && opts.mediaType === 'document') mediaPayload.filename = opts.filename;
      const payload: any = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: opts.mediaType,
        [opts.mediaType]: mediaPayload,
      };
      deliveryAttempted = true;
      return await this.dispatch(creds, token, payload, opts.userId);
    } catch (error: any) {
      if (error && typeof error === 'object') {
        error.deliveryAttempted = error.outcomeUncertain === false ? false : (error.deliveryAttempted ?? deliveryAttempted);
      }
      throw error;
    }
  }

  /** @deprecated kept for back-compat with older callers; use sendText. */
  async sendMessage(userId: number, phoneNumberId: string, recipientPhone: string, text: string) {
    return this.sendText({ userId, phoneNumberId, to: recipientPhone, text });
  }

  // ── Internals ────────────────────────────────────────────────────────────
  private async resolveAndValidate(userId: number, phoneNumberIdHint?: string, receivingMedia = false, approvedTemplate = false): Promise<ResolvedWhatsAppCreds> {
    if (!receivingMedia) assertCustomerDeliveryRuntime('whatsapp');
    const creds = await this.resolveCreds(userId, phoneNumberIdHint);
    if (!creds) throw new Error('WhatsApp not connected. Please configure WhatsApp integration first.');
    if (!creds.phoneNumberId) throw new Error('WhatsApp Phone Number ID not configured.');
    if (!receivingMedia) await assertCustomerDeliveryReady({ userId, channel: 'whatsapp', accountId: creds.phoneNumberId, approvedTemplate });
    if (!receivingMedia && creds.sessionData?.whatsappEnabled === false) {
      const disabledError: any = new Error('WhatsApp messaging is paused for this account. Enable it before sending.');
      disabledError.status = 409;
      disabledError.retryable = false;
      throw disabledError;
    }
    // Rate limit AFTER successful credential resolution.
    await this.rateLimitCheck(userId, creds.phoneNumberId);
    return creds;
  }

  private async dispatch(creds: ResolvedWhatsAppCreds, accessToken: string, payload: any, userId: number) {
    await assertCustomerDeliveryReady({ userId, channel: 'whatsapp', accountId: creds.phoneNumberId, approvedTemplate: payload?.type === 'template' });
    // Shared by outreach and support: opt-out is destination-wide within the
    // active business. Recheck after setup/token work and before provider I/O.
    try {
      await assertRecipientNotSuppressed(userId, 'whatsapp', String(payload.to || ''));
    } catch (cause) {
      const blocked = cause instanceof RecipientSuppressedError;
      throw Object.assign(new Error(blocked ? 'This WhatsApp destination is suppressed.' : 'WhatsApp suppression could not be verified.', { cause }), {
        code: blocked ? 'RECIPIENT_SUPPRESSED' : 'SUPPRESSION_UNAVAILABLE',
        suppressionCheckFailed: true, outcomeUncertain: false, deliveryAttempted: false, retryable: !blocked,
      });
    }
    // Platform-billed WABAs (Meta bills our credit line): price and reserve the
    // message from the customer's wallet last, so nothing above can strand a
    // reservation. Returns null for every other account.
    const billing = await import('./whatsapp/WhatsAppBillingService.js');
    const charge = await billing.reserveWhatsAppSend({
      userId, wabaId: creds.businessAccountId, phoneNumberId: creds.phoneNumberId, payload,
    });
    try {
      const data = await this.postMessage(creds, accessToken, payload);
      if (charge) await billing.markWhatsAppSendAccepted(charge, data?.messages?.[0]?.id);
      return data;
    } catch (error: any) {
      if (charge) await billing.markWhatsAppSendFailed(charge, error);
      throw error;
    }
  }

  private async postMessage(creds: ResolvedWhatsAppCreds, accessToken: string, payload: any) {
    const url = `https://graph.facebook.com/${creds.apiVersion}/${creds.phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const code = data?.error?.code;
      const subcode = data?.error?.error_subcode;
      await this.recordReadiness(creds, { ok: false, code, subcode });
      const errMsg = data?.error?.message || `WhatsApp API HTTP ${response.status}`;
      logger.warn({ status: response.status, error: data?.error }, '[WhatsAppApiService] Send failed');
      const err: any = new Error(errMsg);
      err.code = code;
      err.status = response.status;
      err.metaError = data?.error;
      err.outcomeUncertain = response.status >= 500 && !data?.error;
      // Retry classification is consumed by durable delivery jobs. Meta uses
      // 429 and 5xx for transient errors; auth, recipient and template
      // validation failures must be surfaced rather than retried forever.
      err.retryable = metaRetryable(code, response.status);
      const retryAt = providerRetryAfter(response.headers.get('retry-after'));
      err.retryAfterMs = retryAt ? Date.parse(retryAt) - Date.now() : undefined;
      throw err;
    }
    await this.recordReadiness(creds, { ok: true });
    return data;
  }

  private async getApiVersion(): Promise<string> {
    try {
      const { getGraphApiVersion } = await import('../utils/metaApiVersion.js');
      return await getGraphApiVersion();
    } catch {
      return 'v25.0';
    }
  }

  /**
   * Subscribe a WABA to webhooks. Idempotent — Meta returns success if already subscribed.
   */
  async subscribeWabaWebhook(wabaId: string, accessToken: string, apiVersion: string): Promise<{ success: boolean; error?: any }> {
    try {
      const resp = await fetch(`https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data: any = await resp.json();
      if (data.success) return { success: true };
      return { success: false, error: data?.error || data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

export const whatsappApiService = new WhatsAppApiService();
