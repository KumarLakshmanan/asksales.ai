import {
  resolveInstagramAccountContext,
  type InstagramAccountContext,
} from '../instagramAccountSelectionService.js';
import {
  isDirectInstagramLogin,
  isUsableInstagramCredential,
} from '../../utils/instagramOAuthCredential.js';
import { boundMetaPageToken, decryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { getGraphApiVersion } from '../../utils/metaApiVersion.js';
import {
  getMetaCapabilityStatuses,
  type MetaPermission,
} from '../integrations/MetaCapabilityRegistry.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { assertCustomerDeliveryReady } from '../assistants/CustomerDeliveryGate.js';
import {
  renderInstagramText,
  instagramTextBytes,
  validateInstagramMessage,
  type InstagramAutomationReadiness,
  type InstagramMessage,
  type InstagramProfileConfig,
  type InstagramProfileKind,
  type InstagramAutomationMedia,
} from '../../../shared/instagramAutomations.js';

export class InstagramAutomationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
export class InstagramProviderError extends InstagramAutomationError {
  constructor(
    message: string,
    public uncertain = false,
    public providerCode?: number
  ) {
    super(message, 502);
  }
}
export const instagramAutomationsEnabled = (accountId: string): boolean =>
  process.env.INSTAGRAM_AUTOMATIONS_ENABLED === 'true' ||
  (process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS || '')
    .split(',')
    .map((x) => x.trim())
    .includes(accountId);
export async function requireInstagramAutomationAccount(
  userId: number,
  accountId: string
): Promise<InstagramAccountContext> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId || !/^\d{1,255}$/.test(accountId))
    throw new InstagramAutomationError('Instagram account not found.', 404);
  const account = await resolveInstagramAccountContext(userId, { accountIdentifier: accountId });
  if (
    !account ||
    account.credential.businessProfileId !== scope.businessProfileId ||
    account.credential.userId !== userId
  )
    throw new InstagramAutomationError(
      'Instagram account not found in this business profile.',
      404
    );
  return account;
}
export async function instagramAutomationReadiness(
  account: InstagramAccountContext
): Promise<InstagramAutomationReadiness> {
  const direct = isDirectInstagramLogin(account.credential),
    accountId = account.credential.accountIdentifier!;
  const permissions: MetaPermission[] = direct
    ? ['instagram_business_manage_messages', 'instagram_business_manage_comments']
    : ['instagram_manage_messages', 'instagram_manage_comments'];
  const dependencies: MetaPermission[] = direct
    ? ['instagram_business_basic']
    : ['instagram_basic', 'pages_read_engagement', 'pages_manage_metadata'];
  const usable =
    isUsableInstagramCredential(account.credential) && !account.credential.readinessErrorCode;
  const authorized = isUsableInstagramCredential(account.credential) &&
    (!account.credential.readinessErrorCode || ['APP_REVIEW', 'WEBHOOK_SUBSCRIPTION'].includes(account.credential.readinessErrorCode));
  const enabled = instagramAutomationsEnabled(accountId);
  const subscribed = Boolean(account.connection?.webhookSubscribed);
  const capabilities = await getMetaCapabilityStatuses({
    scopes: account.credential.grantedScopes,
    accountReady: usable && subscribed,
    permissions: [...permissions, ...dependencies],
  });
  const testAccount = (process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS || '')
    .split(',')
    .map((x) => x.trim())
    .includes(accountId);
  const ready = (scope: string) =>
    capabilities.some(
      (c) =>
        c.scope === scope &&
        c.tokenGranted &&
        c.accountReady &&
        (c.status === 'available' || (testAccount && c.appReviewStatus === 'testing'))
    );
  const dependenciesReady = dependencies.every(ready);
  const messages = enabled && dependenciesReady && ready(permissions[0]),
    comments = enabled && dependenciesReady && ready(permissions[1]);
  return {
    authorized,
    expiresAt: account.credential.tokenExpiry ? new Date(account.credential.tokenExpiry).toISOString() : null,
    checks: [
      { id: 'connection', title: 'Account authorization', ready: authorized, action: authorized ? null : 'reconnect' },
      { id: 'events', title: 'Comment and message events', ready: subscribed, action: subscribed ? null : 'reconnect' },
      { id: 'rollout', title: 'Live automation access', ready: enabled, action: enabled ? null : 'administrator' },
      ...capabilities.map(c => ({ id: c.scope, title: c.feature, ready: ready(c.scope), action: ready(c.scope) ? null : !c.tokenGranted ? 'reconnect' as const : 'administrator' as const })),
    ],
    enabled,
    messages,
    comments,
    profile: messages,
    richMessages: messages,
    reasons: [
      ...(!enabled
        ? ['Instagram automations await administrator rollout approval. Drafts can still be saved.']
        : []),
      ...(!authorized
        ? ['Reconnect this Instagram account before publishing or activating automations.']
        : []),
      ...(!subscribed ? ['Reconnect Instagram to restore its webhook subscription.'] : []),
      ...capabilities
        .filter((c) => !ready(c.scope))
        .map((c) => `${c.feature}: ${c.reason || 'permission is unavailable.'}`),
    ],
  };
}
export function profileProviderValue(
  kind: InstagramProfileKind,
  config: InstagramProfileConfig
): unknown[] {
  return config.locales.map((group) =>
    kind === 'icebreakers'
      ? {
          locale: group.locale,
          call_to_actions: group.questions.map((q) => ({
            question: q.question,
            payload: `IGA_START_${q.id}`,
          })),
        }
      : {
          locale: group.locale,
          call_to_actions: group.items.map((item) =>
            item.type === 'link'
              ? { type: 'web_url', title: item.title, url: item.url }
              : { type: 'postback', title: item.title, payload: `IGA_MENU_${item.payload}` }
          ),
        }
  );
}
export function instagramMessagePayload(
  message: InstagramMessage,
  values: { username?: string; name?: string; keyword?: string } = {}
): Record<string, unknown> {
  const text = renderInstagramText(message.text, values),
    buttons = (items: InstagramMessage['buttons']) =>
      items.map((b) => ({ type: 'web_url', title: b.title, url: b.url }));
  const errors = validateInstagramMessage({ ...message, text });
  if (errors.length)
    throw new InstagramAutomationError(
      `The response exceeds Instagram's message limits or is incomplete. ${errors.join(' ')}`
    );
  if (message.format === 'quick_replies')
    return {
      text,
      quick_replies: message.quickReplies.map((q) => ({
        content_type: 'text',
        title: q.title,
        payload: q.payload,
      })),
    };
  if (message.format === 'buttons')
    return {
      attachment: {
        type: 'template',
        payload: { template_type: 'button', text, buttons: buttons(message.buttons) },
      },
    };
  if (message.format === 'carousel')
    return {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: message.cards.map((c) => ({
            title: renderInstagramText(c.title, values).slice(0, 80),
            ...(c.subtitle ? { subtitle: renderInstagramText(c.subtitle, values).slice(0, 80) } : {}),
            ...(c.imageUrl ? { image_url: c.imageUrl } : {}),
            ...(c.buttons.length ? { buttons: buttons(c.buttons) } : {}),
          })),
        },
      },
    };
  return { text };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export class InstagramAutomationProvider {
  constructor(private account: InstagramAccountContext) {}
  get accountId() {
    return this.account.credential.accountIdentifier!;
  }
  private get direct() {
    return isDirectInstagramLogin(this.account.credential);
  }
  private get actorId() {
    return this.direct ? this.accountId : this.account.connection?.pageId || this.accountId;
  }
  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: Record<string, unknown>
  ): Promise<T> {
    const token = decryptMetaSecret(
      this.direct
        ? this.account.credential.accessToken
        : boundMetaPageToken(this.account.credential) ||
            this.account.connection?.pageAccessToken ||
            this.account.credential.accessToken
    );
    if (!token)
      throw new InstagramAutomationError('Reconnect Instagram to restore the access token.', 409);
    const url = new URL(
      `https://graph.${this.direct ? 'instagram' : 'facebook'}.com/${await getGraphApiVersion()}${path}`
    );
    if (method === 'GET')
      Object.entries(body || {}).forEach(([key, value]) =>
        url.searchParams.set(key, String(value))
      );
    let response: Response;
    if (method === 'POST' && path.endsWith('/messages')) {
      await assertCustomerDeliveryReady({ userId: this.account.credential.userId, channel: 'instagram', accountId: this.accountId });
    }
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new InstagramProviderError(
        'Instagram did not confirm the request. Check the execution before retrying.',
        method !== 'GET'
      );
    }
    const data = (await response.json().catch(() => null)) as
      | (T & { error?: { code?: number; message?: string } })
      | null;
    if (!response.ok || !data || data.error) {
      // Provider error messages can echo private input. Return a stable, token-free message.
      const code = data?.error?.code;
      const subcode = (data?.error as { error_subcode?: number } | undefined)?.error_subcode;
      const rateLimited = response.status === 429 || [4, 17, 32, 613, 80001, 80002, 80006].includes(code || 0);
      throw new InstagramProviderError(
        rateLimited ? 'Instagram is limiting requests for this account. Wait before testing again; previous sends are not replayed automatically.'
          : subcode === 2534022 || subcode === 2018278 ? 'The Instagram messaging window has closed. Ask the person to message you again before sending follow-up content.'
            : subcode === 2534025 ? 'This comment cannot receive a private reply. Use a fresh eligible comment within seven days; only one initial private reply is allowed.'
              : subcode === 2534041 ? 'The account owner disabled Instagram message access. Restore message access and reconnect this account.'
                : code === 190
          ? 'Instagram authorization expired. Reconnect this account.'
          : code === 10 || code === 200
            ? 'Meta has not authorized this operation for the account.'
            : `Instagram rejected or could not confirm this operation${code ? ` (code ${code})` : ''}.`,
        method !== 'GET' && !code && !rateLimited,
        code
      );
    }
    return data;
  }
  async assertReady(kind: 'messages' | 'comments' | 'comment_dm' | 'profile') {
    const r = await instagramAutomationReadiness(this.account);
    if (!(kind === 'comment_dm' ? r.comments && r.messages : r[kind]))
      throw new InstagramAutomationError(r.reasons.join(' ') || 'Instagram is not ready.', 409);
    const result = await this.request<{ data?: Array<{ subscribed_fields?: string[] }> }>(
      `/${this.actorId}/subscribed_apps`
    );
    const fields = new Set((result.data || []).flatMap((app) => app.subscribed_fields || []));
    const required =
      kind === 'comments'
        ? ['comments']
        : kind === 'comment_dm'
          ? ['messages', 'messaging_postbacks', 'comments']
          : ['messages', 'messaging_postbacks'];
    if (!required.every((f) => fields.has(f)))
      throw new InstagramAutomationError(
        `Instagram is missing the required subscription: ${required.filter((f) => !fields.has(f)).join(', ')}. Reconnect this account.`,
        409
      );
  }
  async connectionHealth(): Promise<InstagramAutomationReadiness> {
    const readiness = await instagramAutomationReadiness(this.account);
    if (!readiness.checks?.find(check => check.id === 'connection')?.ready) return readiness;
    try {
      const result = await this.request<{ data?: Array<{ subscribed_fields?: string[] }> }>(`/${this.actorId}/subscribed_apps`);
      const fields = new Set((result.data || []).flatMap(app => app.subscribed_fields || []));
      const messages = fields.has('messages') && fields.has('messaging_postbacks'), comments = fields.has('comments');
      readiness.messages = readiness.messages && messages; readiness.profile = readiness.messages; readiness.richMessages = readiness.messages; readiness.comments = readiness.comments && comments;
      readiness.checks = readiness.checks?.map(check => check.id === 'events' ? { ...check, ready: messages && comments, action: messages && comments ? null : 'reconnect' } : check);
      const missing = ['messages', 'messaging_postbacks', 'comments'].filter(field => !fields.has(field));
      if (missing.length) readiness.reasons.push(`Reconnect Instagram to restore these event subscriptions: ${missing.join(', ')}.`);
    } catch (cause) {
      const reconnect = cause instanceof InstagramProviderError && cause.providerCode === 190;
      if (reconnect) {
        readiness.authorized = false;
        readiness.checks = readiness.checks?.map(check => check.id === 'connection' ? { ...check, ready: false, action: 'reconnect' } : check);
      }
      readiness.messages = readiness.profile = readiness.richMessages = readiness.comments = false;
      readiness.checks?.push({ id: 'verification', title: 'Current provider verification', ready: false, action: reconnect ? 'reconnect' : 'administrator' });
      readiness.reasons.push(cause instanceof InstagramAutomationError ? cause.message : 'Instagram connection could not be verified. Try checking again.');
    }
    return readiness;
  }
  async media(after?: string) {
    const result = await this.request<{
      data?: InstagramAutomationMedia[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(`/${this.accountId}/media`, 'GET', {
      fields: this.direct
        ? 'id,media_type,media_url,thumbnail_url,permalink'
        : 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink',
      limit: 25,
      ...(after ? { after } : {}),
    });
    return {
      media: (result.data || []).map((media) => ({
        ...media,
        ...(this.direct && this.isReelPermalink(media.permalink)
          ? { media_product_type: 'REELS' }
          : {}),
      })),
      nextCursor: result.paging?.next ? result.paging.cursors?.after || null : null,
    };
  }
  async mediaIsReel(id: string): Promise<boolean> {
    const result = await this.request<{
      media_product_type?: string;
      permalink?: string;
      owner?: { id?: string };
    }>(
      `/${encodeURIComponent(id)}`,
      'GET',
      { fields: this.direct ? 'permalink,owner' : 'media_product_type,owner' }
    );
    if (result.owner?.id !== this.accountId)
      throw new InstagramAutomationError('Instagram did not confirm that this media belongs to the connected account.');
    return this.direct
      ? this.isReelPermalink(result.permalink)
      : result.media_product_type === 'REELS';
  }
  private isReelPermalink(permalink?: string): boolean {
    if (!permalink) return false;
    try {
      const url = new URL(permalink);
      return (
        (url.hostname === 'instagram.com' || url.hostname.endsWith('.instagram.com')) &&
        /^\/reels?\//.test(url.pathname)
      );
    } catch {
      return false;
    }
  }
  async verifyMedia(ids: string[]) {
    for (const id of ids) {
      const media = await this.request<{ owner?: { id?: string } }>(
        `/${encodeURIComponent(id)}`,
        'GET',
        { fields: 'owner' }
      );
      if (media.owner?.id !== this.accountId)
        throw new InstagramAutomationError('Select media owned by this Instagram account.');
    }
  }
  async followStatus(senderId: string): Promise<boolean | null> {
    try {
      const p = await this.request<{ is_user_follow_business?: boolean }>(
        `/${encodeURIComponent(senderId)}`,
        'GET',
        { fields: 'is_user_follow_business' }
      );
      return typeof p.is_user_follow_business === 'boolean' ? p.is_user_follow_business : null;
    } catch {
      return null;
    }
  }
  async publishProfile(kind: InstagramProfileKind, config: InstagramProfileConfig, remove = false) {
    await this.assertReady('profile');
    const field = kind === 'icebreakers' ? 'ice_breakers' : 'persistent_menu';
    const path = `/${this.actorId}/messenger_profile`,
      extra = { platform: 'instagram' };
    const expected = remove ? [] : profileProviderValue(kind, config);
    const accepted = await this.request<{ success?: boolean; result?: string }>(
      path,
      remove ? 'DELETE' : 'POST',
      { ...extra, ...(remove ? { fields: [field] } : { [field]: expected }) }
    );
    if (accepted.success !== true && accepted.result !== 'success')
      throw new InstagramProviderError(
        'Instagram did not confirm the profile update. Review the saved draft.'
      );
    await this.verifyProfile(kind, config, remove);
  }
  /** Read-only reconciliation also works after a worker/API restart. */
  async verifyProfile(kind: InstagramProfileKind, config: InstagramProfileConfig, remove = false) {
    const field = kind === 'icebreakers' ? 'ice_breakers' : 'persistent_menu';
    const path = `/${this.actorId}/messenger_profile`,
      extra = { platform: 'instagram' };
    const expected = remove ? [] : profileProviderValue(kind, config);
    const readback = await this.request<{
      data?: Array<Record<string, unknown>>;
      persistent_menu?: unknown[];
      ice_breakers?: unknown[];
    }>(path, 'GET', {
      ...extra,
      fields: field,
    });
    const topLevel = readback[field];
    if (!Array.isArray(readback.data) && !Array.isArray(topLevel))
      throw new InstagramProviderError(
        'Instagram returned an incomplete profile readback. Publication is not confirmed.'
      );
    // Icebreaker reads return the locale groups directly. Older menu/profile
    // endpoints wrap the groups in the requested field instead.
    const wrapped = readback.data?.[0]?.[field];
    const actual = Array.isArray(topLevel)
      ? topLevel
      : Array.isArray(wrapped)
        ? wrapped
        : readback.data;
    const normalize = (groups: unknown) =>
      Array.isArray(groups)
        ? groups
            .map((group) => {
              const value = group as Record<string, unknown>;
              return { locale: value?.locale, call_to_actions: value?.call_to_actions };
            })
            .sort((a, b) => String(a.locale).localeCompare(String(b.locale)))
        : groups;
    if (canonical(normalize(actual)) !== canonical(normalize(expected)))
      throw new InstagramProviderError(
        'Instagram accepted the update but its readback differs. Review the draft and publish again.'
      );
  }
  async sendPrivateReply(commentId: string, text: string) {
    if (!text.trim() || instagramTextBytes(text) > 1000)
      throw new InstagramAutomationError('Private reply text must contain 1–1,000 UTF-8 bytes.');
    // Private replies are addressed through the Instagram professional account
    // for both login methods; normal Facebook-backed DMs use the Page actor.
    return this.send({ comment_id: commentId }, { text }, this.accountId);
  }
  async sendMessage(
    recipientId: string,
    message: InstagramMessage,
    values?: { username?: string; name?: string; keyword?: string }
  ) {
    return this.send({ id: recipientId }, instagramMessagePayload(message, values));
  }
  private async send(
    recipient: Record<string, string>,
    message: Record<string, unknown>,
    actorId = this.actorId
  ) {
    const result = await this.request<{ message_id?: string; recipient_id?: string }>(
      `/${actorId}/messages`,
      'POST',
      { recipient, message }
    );
    if (!result.message_id)
      throw new InstagramProviderError(
        'Instagram returned no message receipt. Delivery requires review.',
        true
      );
    return { messageId: result.message_id, recipientId: result.recipient_id || null };
  }
}
