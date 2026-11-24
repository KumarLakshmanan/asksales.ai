import crypto from 'node:crypto';
import { extractBlogBody } from '../../../shared/blogContent.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../models/db.js';
import {
  aiVisibilityAssetApprovalDecisionsTable,
  aiVisibilityCmsPublishAttemptsTable,
  aiVisibilityGeneratedAssetLinksTable,
  aiVisibilityProjectsTable,
  type CmsDraftSnapshot,
  type CmsPlatform,
} from '../../models/aiVisibility/schema.js';
import { contentAssetsTable } from '../../models/contentAssets/schema.js';
import {
  deleteCredential,
  getCredential,
  saveCredential,
} from '../credentialService.js';
import {
  fetchPublicHttpUrl,
  readResponseBuffer,
} from '../../utils/safeRemoteFetch.js';
import { asRecord } from '../../../shared/records.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CMS_TIMEOUT_MS = 20_000;
const SHOPIFY_API_VERSION = '2026-07';

export class CmsPublishingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'CmsPublishingError';
  }
}

class RemoteCmsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly ambiguous = false,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export type CmsConnectionInput =
  | {
      platform: 'wordpress';
      siteUrl: string;
      username: string;
      applicationPassword: string;
    }
  | {
      platform: 'shopify';
      storeDomain: string;
      accessToken: string;
      blogId?: string;
      authorName?: string;
    };

interface StoredCmsCredential {
  id: number;
  apiSecret: string;
  config: Record<string, unknown>;
}

interface DraftResult {
  destinationId: string;
  destinationUrl: string;
  reconciled: boolean;
}

interface ExactAssetApprovalDecision {
  actorUserId: number;
  assetVersion: number;
  decision: string;
  createdAt: Date;
}

export function requireExactAiVisibilityAssetApproval(input: {
  assetVersion: number;
  assetApprovalStatus: string;
  assetApprovedBy: number | null;
  assetApprovedAt: Date | null;
  decision: ExactAssetApprovalDecision | null | undefined;
}): ExactAssetApprovalDecision {
  if (
    input.assetApprovalStatus === 'approved' &&
    input.assetApprovedBy &&
    input.assetApprovedAt &&
    input.decision?.decision === 'approved' &&
    input.decision.assetVersion === input.assetVersion
  )
    return input.decision;
  throw new CmsPublishingError(
    'Approve this exact asset version in AI Visibility before creating a CMS draft.',
    'ASSET_APPROVAL_REQUIRED',
    409,
  );
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new CmsPublishingError(
      'Enter a valid public website URL.',
      'INVALID_SITE_URL',
    );
  }
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new CmsPublishingError(
      'Enter a valid public website URL.',
      'INVALID_SITE_URL',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CmsPublishingError(
      'Enter a valid public website URL without credentials, query parameters, or fragments.',
      'INVALID_SITE_URL',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function normalizeShopifyStoreDomain(raw: string): string {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) {
    throw new CmsPublishingError(
      'Use the permanent store-name.myshopify.com domain.',
      'INVALID_SHOPIFY_DOMAIN',
    );
  }
  return value;
}

export function normalizeWordPressSiteUrl(raw: string): string {
  return normalizeBaseUrl(raw);
}

export function cmsDraftHandle(
  title: string,
  assetId: number,
  assetVersion: number,
): string {
  const base =
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'ai-visibility-draft';
  return `${base}-ai-${assetId}-v${assetVersion}`;
}

export function extractCmsBody(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    for (const key of ['body', 'content', 'answer', 'draft', 'description']) {
      if (typeof parsed[key] === 'string' && parsed[key].trim())
        return extractBlogBody(parsed[key]).trim();
    }
  } catch {
    // Plain text and HTML assets are already usable by CMS editors.
  }
  return extractBlogBody(content).trim();
}

function fingerprint(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: { ambiguousOnNetworkFailure?: boolean } = {},
): Promise<{ status: number; data: unknown }> {
  try {
    const { response } = await fetchPublicHttpUrl(
      url,
      {
        ...init,
        signal: AbortSignal.timeout(CMS_TIMEOUT_MS),
        headers: { Accept: 'application/json', ...(init.headers || {}) },
      },
      0,
    );
    const raw = await readResponseBuffer(response, MAX_RESPONSE_BYTES);
    let data: unknown = null;
    if (raw.length) {
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new RemoteCmsError(
          'The CMS returned an invalid JSON response.',
          'INVALID_CMS_RESPONSE',
          Boolean(options.ambiguousOnNetworkFailure),
        );
      }
    }
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof RemoteCmsError) throw error;
    throw new RemoteCmsError(
      error instanceof Error ? error.message : 'The CMS request failed.',
      'CMS_NETWORK_ERROR',
      Boolean(options.ambiguousOnNetworkFailure),
      true,
    );
  }
}

function wordpressHeaders(username: string, applicationPassword: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function shopifyHeaders(accessToken: string) {
  return {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };
}

async function verifyWordPress(
  input: Extract<CmsConnectionInput, { platform: 'wordpress' }>,
) {
  const siteUrl = normalizeWordPressSiteUrl(input.siteUrl);
  const { status, data } = await requestJson(
    `${siteUrl}/wp-json/wp/v2/users/me?context=edit`,
    {
      method: 'GET',
      headers: wordpressHeaders(
        input.username.trim(),
        input.applicationPassword,
      ),
    },
  );
  const user = asRecord(data);
  if (status !== 200 || !user.id)
    throw new CmsPublishingError(
      'WordPress could not verify that username and application password.',
      'WORDPRESS_CONNECTION_FAILED',
      422,
    );
  return {
    siteUrl,
    username: input.username.trim(),
    accountLabel: String(user.name || input.username.trim()),
  };
}

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  ambiguous = false,
) {
  const result = await requestJson(
    `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: shopifyHeaders(accessToken),
      body: JSON.stringify({ query, variables }),
    },
    { ambiguousOnNetworkFailure: ambiguous },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new RemoteCmsError(
      `Shopify returned HTTP ${result.status}.`,
      'SHOPIFY_HTTP_ERROR',
      ambiguous && result.status >= 500,
      result.status >= 500 || result.status === 429,
    );
  }
  const envelope = asRecord(result.data);
  if (Array.isArray(envelope.errors) && envelope.errors.length) {
    throw new RemoteCmsError(
      String(
        asRecord(envelope.errors[0]).message || 'Shopify rejected the request.',
      ),
      'SHOPIFY_GRAPHQL_ERROR',
      ambiguous,
    );
  }
  return asRecord(envelope.data);
}

async function verifyShopify(
  input: Extract<CmsConnectionInput, { platform: 'shopify' }>,
) {
  const storeDomain = normalizeShopifyStoreDomain(input.storeDomain);
  if (
    input.blogId &&
    !/^gid:\/\/shopify\/Blog\/\d+$/.test(input.blogId.trim())
  ) {
    throw new CmsPublishingError(
      'Enter a valid Shopify Blog ID such as gid://shopify/Blog/123456.',
      'INVALID_SHOPIFY_BLOG',
    );
  }
  if (!input.blogId) {
    const data = await shopifyGraphql(
      storeDomain,
      input.accessToken,
      `query VerifyAiVisibilityCatalog { shop { name } }`,
      {},
    );
    const shop = asRecord(data.shop);
    if (!shop.name)
      throw new CmsPublishingError(
        'Shopify could not verify the store token.',
        'SHOPIFY_CONNECTION_FAILED',
        422,
      );
    return {
      storeDomain,
      accountLabel: String(shop.name),
      apiVersion: SHOPIFY_API_VERSION,
      blogId: null,
      blogHandle: null,
      blogTitle: null,
      authorName: null,
    };
  }
  if (!input.authorName?.trim())
    throw new CmsPublishingError(
      'An article author is required when connecting a blog.',
      'MISSING_SHOPIFY_AUTHOR',
    );
  const data = await shopifyGraphql(
    storeDomain,
    input.accessToken,
    `
    query VerifyAiVisibilityCms($blogId: ID!) {
      shop { name }
      blog(id: $blogId) { id title handle }
    }
  `,
    { blogId: input.blogId.trim() },
  );
  const shop = asRecord(data.shop);
  const blog = asRecord(data.blog);
  if (!shop.name || !blog.id)
    throw new CmsPublishingError(
      'Shopify could not verify the store token and blog ID.',
      'SHOPIFY_CONNECTION_FAILED',
      422,
    );
  return {
    storeDomain,
    blogId: input.blogId.trim(),
    blogHandle: String(blog.handle || ''),
    blogTitle: String(blog.title || 'Blog'),
    authorName: input.authorName.trim(),
    accountLabel: String(shop.name),
    apiVersion: SHOPIFY_API_VERSION,
  };
}

async function createWordPressDraft(
  snapshot: CmsDraftSnapshot,
  credential: StoredCmsCredential,
  reconcileOnly = false,
): Promise<DraftResult> {
  const siteUrl = String(credential.config.siteUrl || '');
  const username = String(credential.config.username || '');
  const headers = wordpressHeaders(username, credential.apiSecret);
  const existing = await requestJson(
    `${siteUrl}/wp-json/wp/v2/posts?slug=${encodeURIComponent(snapshot.handle)}&status=draft&context=edit`,
    { method: 'GET', headers },
  );
  if (existing.status !== 200 || !Array.isArray(existing.data)) {
    throw new RemoteCmsError(
      `WordPress draft reconciliation could not be verified (HTTP ${existing.status}).`,
      'WORDPRESS_LOOKUP_FAILED',
      false,
      existing.status >= 500 || existing.status === 429,
    );
  }
  const existingPost = asRecord(existing.data[0]);
  if (existing.data.length) {
    if (
      existing.data.length !== 1 ||
      !existingPost.id ||
      existingPost.slug !== snapshot.handle ||
      existingPost.status !== 'draft'
    ) {
      throw new RemoteCmsError(
        'WordPress did not verify this exact unpublished draft.',
        'WORDPRESS_LOOKUP_CONFLICT',
      );
    }
    const id = String(existingPost.id);
    return {
      destinationId: id,
      destinationUrl: `${siteUrl}/wp-admin/post.php?post=${encodeURIComponent(id)}&action=edit`,
      reconciled: true,
    };
  }
  if (reconcileOnly) {
    throw new RemoteCmsError(
      'The previous CMS create is still uncertain; no matching unpublished draft was found.',
      'CMS_DRAFT_UNCONFIRMED',
      true,
    );
  }
  const created = await requestJson(
    `${siteUrl}/wp-json/wp/v2/posts`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: snapshot.title,
        content: snapshot.body,
        slug: snapshot.handle,
        status: 'draft',
      }),
    },
    { ambiguousOnNetworkFailure: true },
  );
  const createdPost = asRecord(created.data);
  if (created.status < 200 || created.status >= 300 || !createdPost.id) {
    throw new RemoteCmsError(
      String(
        createdPost.message || `WordPress returned HTTP ${created.status}.`,
      ),
      'WORDPRESS_CREATE_FAILED',
      created.status >= 500 || (created.status >= 200 && created.status < 300),
      created.status >= 500 || created.status === 429,
    );
  }
  if (createdPost.status !== 'draft') {
    throw new RemoteCmsError(
      'WordPress did not confirm an unpublished draft.',
      'WORDPRESS_DRAFT_UNCONFIRMED',
      true,
    );
  }
  const id = String(createdPost.id);
  return {
    destinationId: id,
    destinationUrl: `${siteUrl}/wp-admin/post.php?post=${encodeURIComponent(id)}&action=edit`,
    reconciled: false,
  };
}

async function createShopifyDraft(
  snapshot: CmsDraftSnapshot,
  credential: StoredCmsCredential,
  reconcileOnly = false,
): Promise<DraftResult> {
  const storeDomain = String(credential.config.storeDomain || '');
  const blogId = String(credential.config.blogId || '');
  const articleQuery = `
    query FindAiVisibilityArticle($blogId: ID!, $query: String!) {
      blog(id: $blogId) { articles(first: 1, query: $query) { nodes { id handle isPublished } } }
    }
  `;
  const found = await shopifyGraphql(
    storeDomain,
    credential.apiSecret,
    articleQuery,
    {
      blogId,
      query: `handle:${snapshot.handle}`,
    },
  );
  const foundBlog = asRecord(found.blog);
  const foundArticles = asRecord(foundBlog.articles);
  if (!Array.isArray(foundArticles.nodes)) {
    throw new RemoteCmsError(
      'Shopify draft reconciliation could not be verified.',
      'SHOPIFY_LOOKUP_FAILED',
    );
  }
  const existing = Array.isArray(foundArticles.nodes)
    ? asRecord(foundArticles.nodes[0])
    : {};
  if (foundArticles.nodes.length) {
    if (
      !existing.id ||
      existing.handle !== snapshot.handle ||
      existing.isPublished !== false
    ) {
      throw new RemoteCmsError(
        'Shopify did not verify this exact unpublished draft.',
        'SHOPIFY_LOOKUP_CONFLICT',
      );
    }
    const numericId =
      String(existing.id).split('/').pop() || String(existing.id);
    return {
      destinationId: String(existing.id),
      destinationUrl: `https://${storeDomain}/admin/articles/${numericId}`,
      reconciled: true,
    };
  }
  if (reconcileOnly) {
    throw new RemoteCmsError(
      'The previous CMS create is still uncertain; no matching unpublished draft was found.',
      'CMS_DRAFT_UNCONFIRMED',
      true,
    );
  }
  const created = await shopifyGraphql(
    storeDomain,
    credential.apiSecret,
    `
    mutation CreateAiVisibilityArticle($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article { id handle isPublished }
        userErrors { code field message }
      }
    }
  `,
    {
      article: {
        blogId,
        title: snapshot.title,
        body: snapshot.body,
        handle: snapshot.handle,
        author: {
          name: String(credential.config.authorName || 'AI Visibility'),
        },
        isPublished: false,
      },
    },
    true,
  );
  const articleCreate = asRecord(created.articleCreate);
  const errors = articleCreate.userErrors;
  const firstError = Array.isArray(errors) ? asRecord(errors[0]) : {};
  if (Array.isArray(errors) && errors.length)
    throw new RemoteCmsError(
      String(firstError.message || 'Shopify rejected the draft.'),
      String(firstError.code || 'SHOPIFY_CREATE_FAILED'),
    );
  const article = asRecord(articleCreate.article);
  if (!article.id || article.isPublished !== false)
    throw new RemoteCmsError(
      'Shopify did not return an unpublished article.',
      'SHOPIFY_CREATE_FAILED',
      true,
    );
  const numericId = String(article.id).split('/').pop() || String(article.id);
  return {
    destinationId: String(article.id),
    destinationUrl: `https://${storeDomain}/admin/articles/${numericId}`,
    reconciled: false,
  };
}

async function assertOwnedProject(userId: number, projectId: number) {
  const [project] = await db
    .select({ id: aiVisibilityProjectsTable.id })
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
    throw new CmsPublishingError(
      'AI Visibility website not found.',
      'PROJECT_NOT_FOUND',
      404,
    );
}

async function requireCredential(
  userId: number,
  platform: CmsPlatform,
): Promise<StoredCmsCredential> {
  const credential = await getCredential(userId, platform);
  if (!credential?.id || !credential.apiSecret || !credential.config) {
    throw new CmsPublishingError(
      `Connect ${platform === 'wordpress' ? 'WordPress' : 'Shopify'} before creating a draft.`,
      'CMS_NOT_CONNECTED',
      409,
    );
  }
  return credential as StoredCmsCredential;
}

export class CmsDraftPublishingService {
  async connections(userId: number, projectId: number) {
    await assertOwnedProject(userId, projectId);
    const result = [];
    for (const platform of ['wordpress', 'shopify'] as const) {
      const credential = await getCredential(userId, platform);
      result.push({
        platform,
        connected: Boolean(credential?.id && credential.apiSecret),
        publishingReady: Boolean(
          credential?.id &&
          credential.apiSecret &&
          (platform === 'wordpress' ||
            (credential.config?.blogId && credential.config?.authorName)),
        ),
        accountLabel: credential?.config?.accountLabel || null,
        siteUrl:
          platform === 'wordpress' ? credential?.config?.siteUrl || null : null,
        storeDomain:
          platform === 'shopify'
            ? credential?.config?.storeDomain || null
            : null,
        blogTitle:
          platform === 'shopify' ? credential?.config?.blogTitle || null : null,
      });
    }
    return result;
  }

  async saveConnection(
    userId: number,
    projectId: number,
    input: CmsConnectionInput,
  ) {
    await assertOwnedProject(userId, projectId);
    if (input.platform === 'wordpress') {
      if (!input.username.trim() || !input.applicationPassword.trim())
        throw new CmsPublishingError(
          'WordPress username and application password are required.',
          'MISSING_WORDPRESS_CREDENTIALS',
        );
      const config = await verifyWordPress(input);
      if (
        !(await saveCredential(
          userId,
          'wordpress',
          '',
          input.applicationPassword.trim(),
          config,
        ))
      )
        throw new CmsPublishingError(
          'WordPress connection could not be saved.',
          'CREDENTIAL_SAVE_FAILED',
          500,
        );
    } else {
      if (!input.accessToken.trim())
        throw new CmsPublishingError(
          'Shopify access token is required.',
          'MISSING_SHOPIFY_CREDENTIALS',
        );
      const config = await verifyShopify(input);
      if (
        !(await saveCredential(
          userId,
          'shopify',
          '',
          input.accessToken.trim(),
          config,
        ))
      )
        throw new CmsPublishingError(
          'Shopify connection could not be saved.',
          'CREDENTIAL_SAVE_FAILED',
          500,
        );
    }
    return (await this.connections(userId, projectId)).find(
      (item) => item.platform === input.platform,
    )!;
  }

  async deleteConnection(
    userId: number,
    projectId: number,
    platform: CmsPlatform,
  ) {
    await assertOwnedProject(userId, projectId);
    if (!(await deleteCredential(userId, platform)))
      throw new CmsPublishingError(
        'CMS connection could not be removed.',
        'CREDENTIAL_DELETE_FAILED',
        500,
      );
    return { platform, connected: false };
  }

  async attempts(userId: number, projectId: number) {
    await assertOwnedProject(userId, projectId);
    return db
      .select()
      .from(aiVisibilityCmsPublishAttemptsTable)
      .where(
        and(
          eq(aiVisibilityCmsPublishAttemptsTable.userId, userId),
          eq(aiVisibilityCmsPublishAttemptsTable.projectId, projectId),
        ),
      )
      .orderBy(desc(aiVisibilityCmsPublishAttemptsTable.createdAt));
  }

  async createDraft(
    userId: number,
    projectId: number,
    generatedAssetLinkId: number,
    platform: CmsPlatform,
    idempotencyKey: string,
    expectedAssetVersion?: number,
    checkOutcomeOnly = false,
  ) {
    await assertOwnedProject(userId, projectId);
    const preparation = await db.transaction(async (tx: typeof db) => {
      const [record] = await tx
        .select({
          link: aiVisibilityGeneratedAssetLinksTable,
          asset: contentAssetsTable,
        })
        .from(aiVisibilityGeneratedAssetLinksTable)
        .innerJoin(
          contentAssetsTable,
          and(
            eq(
              contentAssetsTable.id,
              aiVisibilityGeneratedAssetLinksTable.contentAssetId,
            ),
            eq(contentAssetsTable.userId, userId),
          ),
        )
        .where(
          and(
            eq(aiVisibilityGeneratedAssetLinksTable.id, generatedAssetLinkId),
            eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
            eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!record)
        throw new CmsPublishingError(
          "Generated asset not found.",
          "ASSET_NOT_FOUND",
          404,
        );
      if (
        expectedAssetVersion !== undefined &&
        record.asset.version !== expectedAssetVersion
      ) {
        throw new CmsPublishingError(
          "This asset changed after review. Reload and review its current version before creating a CMS draft.",
          "ASSET_VERSION_CHANGED",
          409,
        );
      }
      const [approvalDecision] = await tx
        .select({
          actorUserId: aiVisibilityAssetApprovalDecisionsTable.actorUserId,
          assetVersion: aiVisibilityAssetApprovalDecisionsTable.assetVersion,
          decision: aiVisibilityAssetApprovalDecisionsTable.decision,
          createdAt: aiVisibilityAssetApprovalDecisionsTable.createdAt,
        })
        .from(aiVisibilityAssetApprovalDecisionsTable)
        .where(
          and(
            eq(aiVisibilityAssetApprovalDecisionsTable.projectId, projectId),
            eq(
              aiVisibilityAssetApprovalDecisionsTable.generatedAssetLinkId,
              generatedAssetLinkId,
            ),
            eq(
              aiVisibilityAssetApprovalDecisionsTable.contentAssetId,
              record.asset.id,
            ),
            eq(
              aiVisibilityAssetApprovalDecisionsTable.assetVersion,
              record.asset.version,
            ),
            eq(aiVisibilityAssetApprovalDecisionsTable.decision, "approved"),
          ),
        )
        .limit(1);
      const exactApproval = requireExactAiVisibilityAssetApproval({
        assetVersion: record.asset.version,
        assetApprovalStatus: record.asset.approvalStatus,
        assetApprovedBy: record.asset.approvedBy,
        assetApprovedAt: record.asset.approvedAt,
        decision: approvalDecision,
      });
      const body = extractCmsBody(record.asset.content);
      if (!body)
        throw new CmsPublishingError(
          "The approved asset has no publishable content.",
          "EMPTY_ASSET",
          409,
        );
      const credential = await requireCredential(userId, platform);
      if (
        platform === "shopify" &&
        (!credential.config.blogId || !credential.config.authorName)
      )
        throw new CmsPublishingError(
          "Connect a Shopify blog and article author in publishing settings before creating a draft.",
          "SHOPIFY_BLOG_REQUIRED",
          409,
        );
      const snapshot: CmsDraftSnapshot = {
        platform,
        title: record.asset.title,
        body,
        handle: cmsDraftHandle(
          record.asset.title,
          record.asset.id,
          record.asset.version,
        ),
        assetVersion: record.asset.version,
        approvedBy: exactApproval.actorUserId,
        approvedAt: exactApproval.createdAt.toISOString(),
        destination:
          platform === "wordpress"
            ? {
                siteUrl: String(credential.config.siteUrl || ""),
                username: String(credential.config.username || ""),
              }
            : {
                storeDomain: String(credential.config.storeDomain || ""),
                blogId: String(credential.config.blogId || ""),
              },
      };
      const payloadFingerprint = fingerprint(snapshot);
      // The asset row lock serializes different browser keys for the same
      // version. Freeze approval and intent together, then release before HTTP.
      const [keyIntent] = await tx
        .select()
        .from(aiVisibilityCmsPublishAttemptsTable)
        .where(
          and(
            eq(aiVisibilityCmsPublishAttemptsTable.userId, userId),
            eq(
              aiVisibilityCmsPublishAttemptsTable.idempotencyKey,
              idempotencyKey,
            ),
          ),
        )
        .limit(1);
      if (
        keyIntent &&
        (keyIntent.generatedAssetLinkId !== generatedAssetLinkId ||
          keyIntent.platform !== platform ||
          keyIntent.payloadFingerprint !== payloadFingerprint)
      ) {
        throw new CmsPublishingError(
          "This idempotency key was already used for a different CMS draft.",
          "IDEMPOTENCY_KEY_REUSED",
          409,
        );
      }
      const [samePayload] = keyIntent
        ? [keyIntent]
        : await tx
            .select()
            .from(aiVisibilityCmsPublishAttemptsTable)
            .where(
              and(
                eq(aiVisibilityCmsPublishAttemptsTable.userId, userId),
                eq(aiVisibilityCmsPublishAttemptsTable.projectId, projectId),
                eq(
                  aiVisibilityCmsPublishAttemptsTable.generatedAssetLinkId,
                  generatedAssetLinkId,
                ),
                eq(aiVisibilityCmsPublishAttemptsTable.platform, platform),
                eq(
                  aiVisibilityCmsPublishAttemptsTable.assetVersion,
                  record.asset.version,
                ),
                eq(
                  aiVisibilityCmsPublishAttemptsTable.payloadFingerprint,
                  payloadFingerprint,
                ),
              ),
            )
            .orderBy(desc(aiVisibilityCmsPublishAttemptsTable.id))
            .limit(1);
      if (checkOutcomeOnly && !samePayload)
        throw new CmsPublishingError(
          "No existing CMS draft intent matches this outcome check.",
          "PUBLISH_INTENT_NOT_FOUND",
          409,
        );
      const [inserted] = samePayload
        ? []
        : await tx
            .insert(aiVisibilityCmsPublishAttemptsTable)
            .values({
              userId,
              projectId,
              auditId: record.link.auditId,
              generatedAssetLinkId,
              contentAssetId: record.asset.id,
              credentialId: credential.id,
              platform,
              idempotencyKey,
              assetVersion: record.asset.version,
              payloadFingerprint,
              reviewedPayload: snapshot,
            })
            .onConflictDoNothing({
              target: [
                aiVisibilityCmsPublishAttemptsTable.businessProfileId,
                aiVisibilityCmsPublishAttemptsTable.userId,
                aiVisibilityCmsPublishAttemptsTable.idempotencyKey,
              ],
            })
            .returning();
      const [attempt] =
        samePayload || inserted
          ? [samePayload || inserted]
          : await tx
              .select()
              .from(aiVisibilityCmsPublishAttemptsTable)
              .where(
                and(
                  eq(aiVisibilityCmsPublishAttemptsTable.userId, userId),
                  eq(
                    aiVisibilityCmsPublishAttemptsTable.idempotencyKey,
                    idempotencyKey,
                  ),
                ),
              )
              .limit(1);
      if (!attempt)
        throw new CmsPublishingError(
          "CMS draft intent could not be created.",
          "PUBLISH_INTENT_FAILED",
          500,
        );
      if (
        attempt.generatedAssetLinkId !== generatedAssetLinkId ||
        attempt.platform !== platform ||
        attempt.payloadFingerprint !== payloadFingerprint
      ) {
        throw new CmsPublishingError(
          "This idempotency key was already used for a different CMS draft.",
          "IDEMPOTENCY_KEY_REUSED",
          409,
        );
      }
      if (attempt.status === "draft_created")
        return { snapshot, credential, sending: attempt, completed: true };
      if (checkOutcomeOnly) {
        if (!["sending", "ambiguous"].includes(attempt.status))
          throw new CmsPublishingError(
            "This CMS draft does not have an uncertain dispatch to check.",
            "PUBLISH_OUTCOME_NOT_UNCERTAIN",
            409,
          );
        // An explicit read can run alongside the original dispatch. It never
        // claims that dispatch, resets its status or permits another create.
        return {
          snapshot,
          credential,
          sending: attempt,
          completed: false,
          reconcileOnly: true,
          checkOutcomeOnly: true,
        };
      }
      if (attempt.status === "sending")
        throw new CmsPublishingError(
          "This CMS draft has no confirmed outcome yet. Check its outcome without creating another draft.",
          "PUBLISH_IN_PROGRESS",
          409,
        );

      const [sending] = await tx
        .update(aiVisibilityCmsPublishAttemptsTable)
        .set({
          status: "sending",
          credentialId: credential.id,
          attemptCount: attempt.attemptCount + 1,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityCmsPublishAttemptsTable.id, attempt.id),
            eq(aiVisibilityCmsPublishAttemptsTable.userId, userId),
            inArray(aiVisibilityCmsPublishAttemptsTable.status, [
              "pending",
              "retryable_failed",
              "ambiguous",
              "failed",
            ]),
          ),
        )
        .returning();
      if (!sending)
        throw new CmsPublishingError(
          "This CMS draft is already being created.",
          "PUBLISH_IN_PROGRESS",
          409,
        );
      return {
        snapshot,
        credential,
        sending,
        completed: false,
        reconcileOnly: attempt.status === "ambiguous",
      };
    });
    const {
      snapshot,
      credential,
      sending,
      completed,
      reconcileOnly,
      checkOutcomeOnly: checking,
    } = preparation;
    if (completed) return sending;
    const confirmedAttempt = async () => {
      const [saved] = await db
        .select()
        .from(aiVisibilityCmsPublishAttemptsTable)
        .where(
          and(
            eq(aiVisibilityCmsPublishAttemptsTable.id, sending.id),
            eq(aiVisibilityCmsPublishAttemptsTable.userId, userId),
          ),
        )
        .limit(1);
      return saved?.status === "draft_created" ? saved : null;
    };
    try {
      const result =
        platform === "wordpress"
          ? await createWordPressDraft(snapshot, credential, reconcileOnly)
          : await createShopifyDraft(snapshot, credential, reconcileOnly);
      const [completed] = await db
        .update(aiVisibilityCmsPublishAttemptsTable)
        .set({
          status: "draft_created",
          destinationId: result.destinationId,
          destinationUrl: result.destinationUrl,
          reconciliationCount:
            sending.reconciliationCount + (result.reconciled ? 1 : 0),
          lastReconciledAt: result.reconciled ? new Date() : null,
          completedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityCmsPublishAttemptsTable.id, sending.id),
            eq(aiVisibilityCmsPublishAttemptsTable.status, sending.status),
            eq(
              aiVisibilityCmsPublishAttemptsTable.attemptCount,
              sending.attemptCount,
            ),
          ),
        )
        .returning();
      if (completed) return completed;
      const confirmed = await confirmedAttempt();
      if (confirmed) return confirmed;
      throw new RemoteCmsError(
        "The CMS acknowledgement could not be saved to its original intent.",
        "CMS_DRAFT_UNCONFIRMED",
        true,
      );
    } catch (error) {
      // A concurrent read may already have proved the exact remote draft.
      // A late failed acknowledgement must never downgrade that confirmation.
      const confirmed = await confirmedAttempt();
      if (confirmed) return confirmed;
      const remote =
        error instanceof RemoteCmsError
          ? error
          : new RemoteCmsError(
              error instanceof Error
                ? error.message
                : "CMS draft creation failed.",
              "CMS_CREATE_FAILED",
              true,
            );
      const uncertain = reconcileOnly || remote.ambiguous;
      const status = uncertain
        ? "ambiguous"
        : remote.retryable
          ? "retryable_failed"
          : "failed";
      if (!checking)
        await db
          .update(aiVisibilityCmsPublishAttemptsTable)
          .set({
            status,
            errorCode: remote.code,
            errorMessage: remote.message,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(aiVisibilityCmsPublishAttemptsTable.id, sending.id),
              eq(aiVisibilityCmsPublishAttemptsTable.status, sending.status),
              eq(
                aiVisibilityCmsPublishAttemptsTable.attemptCount,
                sending.attemptCount,
              ),
            ),
          );
      throw new CmsPublishingError(
        uncertain
          ? "The CMS outcome is uncertain. Reconcile this action to find its existing unpublished draft; another draft will not be created."
          : remote.message,
        remote.code,
        remote.retryable || uncertain ? 502 : 422,
      );
    }
  }
}

export const cmsDraftPublishingService = new CmsDraftPublishingService();
