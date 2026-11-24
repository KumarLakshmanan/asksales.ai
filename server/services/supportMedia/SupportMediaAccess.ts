import { sql } from 'drizzle-orm';
import type { MediaQuery } from './types.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { assistantResourceIds } from '../assistants/AssistantContext.js';
import { knowledgeBigintArray } from '../knowledge/KnowledgeSql.js';

export type SupportMediaAccessContext = Pick<MediaQuery, 'tenantId' | 'businessProfileId' | 'audience' | 'channel' | 'purpose'>;

/** Shared current authorization for non-owner media reads. SQL aliases g/v/a
 * refer to gallery/version/asset. Owner draft-preview routes intentionally do
 * not use this published-only policy.
 */
export function publishedMediaGalleryAccess(context: SupportMediaAccessContext) {
  const ids=assistantResourceIds('galleries');
  context = { ...context, businessProfileId:context.businessProfileId ?? currentBusinessScope()?.businessProfileId ?? null };
  return sql`
    g.user_id = ${context.tenantId} AND v.user_id = g.user_id AND v.gallery_id = g.id
    AND g.current_published_version_id = v.id
    AND ${ids === undefined ? sql`TRUE` : sql`g.id = ANY(${knowledgeBigintArray([...ids])})`}
    AND g.status = 'active' AND v.status = 'published'
    AND (v.effective_at IS NULL OR v.effective_at <= NOW())
    AND (v.expires_at IS NULL OR v.expires_at > NOW())
    AND ${context.audience} IN ('customer', 'internal')
    AND (${context.audience} = 'internal' OR g.audience = 'customer')
    AND g.audience IN ('customer', 'internal')
    AND (${context.channel.replace(/_comment$/, '')} = ANY(g.allowed_channels) OR cardinality(g.allowed_channels) = 0
      OR (${context.channel}='support_portal' AND ${context.audience}='internal' AND ${context.purpose}='internal_assist'))
    AND (${context.purpose} = ANY(g.usage_scopes) OR 'support_answer' = ANY(g.usage_scopes))
    AND ${context.businessProfileId == null
      ? sql`g.business_profile_id IS NULL`
      : sql`(g.business_profile_id IS NULL OR g.business_profile_id = ${context.businessProfileId})`}
  `;
}

export function publishedMediaAssetAccess(context: SupportMediaAccessContext) {
  return sql`
    ${publishedMediaGalleryAccess(context)}
    AND a.user_id = g.user_id AND a.gallery_id = g.id AND a.gallery_version_id = v.id
    AND a.publication_state = 'published' AND a.retired_at IS NULL
    AND a.sensitivity IN ('public', 'business', 'internal')
    AND (${context.audience} = 'internal' OR a.sensitivity <> 'internal')
  `;
}
