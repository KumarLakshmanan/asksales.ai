import { isDirectInstagramLogin } from '../../utils/instagramOAuthCredential.js';
import { assertCustomerDeliveryReady, CustomerDeliverySetupError, type CustomerDeliveryIdentity } from '../assistants/CustomerDeliveryGate.js';
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { channelCredentialsTable } from "../../models/channelCredentials/schema.js";
import { boundMetaPageToken, decryptMetaSecret } from "../../utils/metaCredentialSecrets.js";
import {
  getGraphApiBase,
  getGraphApiVersion,
} from "../../utils/metaApiVersion.js";
import { asRecord as record } from "../../../shared/records.js";

export type MetaRecord = Record<string, unknown>;
export { record };
export const records = (value: unknown): MetaRecord[] =>
  Array.isArray(value) ? value.map(record) : [];
export class MetaInsightsError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 503,
  ) {
    super(message);
    this.name = "MetaInsightsError";
  }
}

/** Never include provider URLs or tokens in errors. Only id-based Graph paths
 * and same-host cursor values are accepted; paging.next is never fetched. */
export async function createMetaInsightsClient(
  userId: number,
  credentialId: number,
) {
  const credential = (
    await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.id, credentialId),
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.isActive, true),
        ),
      )
      .limit(1)
  )[0];
  if (
    !credential?.accountIdentifier ||
    !["facebook_api", "facebook_page", "instagram_api"].includes(
      credential.platform,
    )
  )
    throw new MetaInsightsError(
      "SOCIAL_ACCOUNT_NOT_FOUND",
      "This social account is no longer connected to this workspace.",
      404,
    );
  if (credential.tokenExpiry && credential.tokenExpiry.getTime() <= Date.now())
    throw new MetaInsightsError(
      "SOCIAL_ANALYTICS_RECONNECT_REQUIRED",
      "Reconnect this account to restore access.",
      422,
    );
  const platform =
    credential.platform === "instagram_api" ? "instagram" : "facebook";
  let token = decryptMetaSecret(credential.accessToken);
  if (platform === "facebook") {
    const page = (
      await db.execute(
        sql`SELECT page_access_token FROM meta_page_connections WHERE user_id=${userId} AND page_id=${credential.accountIdentifier} AND is_active=TRUE LIMIT 1`,
      )
    ).rows[0];
    if (typeof page?.page_access_token === "string")
      token = decryptMetaSecret(page.page_access_token);
    if (boundMetaPageToken(credential)) token = decryptMetaSecret(boundMetaPageToken(credential));
  }
  if (!token)
    throw new MetaInsightsError(
      "SOCIAL_ANALYTICS_RECONNECT_REQUIRED",
      "Reconnect this account to restore access.",
      422,
    );
  const version = await getGraphApiVersion();
  const base = platform === 'instagram' && isDirectInstagramLogin(credential) ? `https://graph.instagram.com/${version}` : getGraphApiBase(version);
  return {
    credential,
    platform: platform as "facebook" | "instagram",
    request: (path: string, query: Record<string, string> = {}) =>
      requestMetaInsights(base, token!, path, query),
    mutate: (path: string, fields: Record<string, string>) =>
      mutateMetaComment(base, token!, path, fields, fetch, { userId, channel: platform, accountId: credential.accountIdentifier!, surface: 'public_comment' }),
  };
}

/** A provider write must never be retried blindly: a timeout may follow a
 * successful publish. Callers persist an idempotency receipt before invoking. */
export async function mutateMetaComment(
  base: string,
  token: string,
  path: string,
  fields: Record<string, string>,
  fetcher: typeof fetch = fetch,
  delivery?: CustomerDeliveryIdentity,
): Promise<MetaRecord> {
  if (!/^[\d_]+(?:\/(?:comments|replies))?$/.test(path))
    throw new MetaInsightsError(
      "SOCIAL_INVALID_RESOURCE",
      "Invalid comment resource.",
      400,
    );
  if (typeof fields.message === 'string') {
    if (!delivery) throw new CustomerDeliverySetupError('account_required', 'An exact verified account and published assistant are required before replying.');
    await assertCustomerDeliveryReady({ ...delivery, surface: 'public_comment' });
  }
  let response: Response;
  try {
    response = await fetcher(`${base}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MetaInsightsError(
      "SOCIAL_ACTION_UNCERTAIN",
      "Meta did not confirm this action. Check the original post before attempting another action.",
      409,
    );
  }
  const payload = record(await response.json().catch(() => null));
  if (response.ok && !payload.error && (payload.id || payload.success === true))
    return payload;
  if (response.status >= 500 || (response.ok && !payload.error))
    throw new MetaInsightsError(
      "SOCIAL_ACTION_UNCERTAIN",
      "Meta did not confirm this action. Check the original post before attempting another action.",
      409,
    );
  const code = Number(record(payload.error).code);
  throw new MetaInsightsError(
    "SOCIAL_ACTION_REJECTED",
    [10, 200, 190].includes(code)
      ? "Meta denied this action. Reconnect with comment management permissions and confirm your account can moderate this post."
      : "Meta rejected this comment action. Check the original post and your account permissions.",
    422,
  );
}

export async function requestMetaInsights(
  base: string,
  token: string,
  path: string,
  query: Record<string, string> = {},
  fetcher: typeof fetch = fetch,
): Promise<MetaRecord> {
  if (!/^[\d_]+(?:\/[a-z_]+)?$/.test(path))
    throw new MetaInsightsError(
      "SOCIAL_INVALID_RESOURCE",
      "Invalid social resource.",
      400,
    );
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      if (!attempt) continue;
      throw new MetaInsightsError(
        "SOCIAL_PROVIDER_TIMEOUT",
        "Meta did not respond in time. Saved data is still available; retry the sync shortly.",
      );
    }
    const payload = record(await response.json().catch(() => null));
    const error = record(payload.error);
    const code = Number(error.code);
    if (response.ok && !payload.error) return payload;
    if (code === 190 || response.status === 401)
      throw new MetaInsightsError(
        "SOCIAL_ANALYTICS_RECONNECT_REQUIRED",
        "Meta authorization expired. Reconnect this social account.",
        422,
      );
    if ([10, 200].includes(code) || response.status === 403)
      throw new MetaInsightsError(
        "SOCIAL_ANALYTICS_PERMISSION_REQUIRED",
        "Meta has not granted access to this data. Reconnect the account and grant the requested permissions.",
        422,
      );
    if ([4, 17, 32, 613].includes(code) || response.status === 429)
      throw new MetaInsightsError(
        "SOCIAL_PROVIDER_RATE_LIMITED",
        "Meta temporarily limited requests. Saved data is available; try again later.",
        429,
      );
    if (response.status >= 500 && !attempt) continue;
    throw new MetaInsightsError(
      code === 100
        ? "SOCIAL_METRIC_UNAVAILABLE"
        : "SOCIAL_PROVIDER_UNAVAILABLE",
      code === 100
        ? "Meta does not expose this field or metric for this content."
        : "Meta could not return this data. Saved measurements were preserved.",
      response.status >= 500 ? 503 : 422,
    );
  }
  throw new MetaInsightsError(
    "SOCIAL_PROVIDER_UNAVAILABLE",
    "Meta could not return this data.",
  );
}
