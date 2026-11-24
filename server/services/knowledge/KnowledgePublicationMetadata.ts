import { KNOWLEDGE_PURPOSES } from './KnowledgeRetrievalPolicy.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { scanKnowledgeContent } from './KnowledgePrivacyService.js';

/** Metadata is reviewed with its content. Draft edits must not move live facts
 * across profile, channel or staff authorization boundaries. */
export interface KnowledgePublicationMetadata {
  title: string;
  sourceUrl: string | null;
  businessProfileId: number | null;
  audience: 'customer' | 'internal';
  accessScope: 'tenant' | 'business_profile' | 'staff_only';
  usageScopes: string[];
  allowedChannels: string[];
  locale: string | null;
}

export const KNOWLEDGE_CHANNELS = ['web', 'whatsapp', 'instagram', 'facebook', 'email', 'internal', 'support_portal'];

export function validateKnowledgePublicationMetadata(value: KnowledgePublicationMetadata, trustedBusinessContacts: readonly string[] = []): KnowledgePublicationMetadata {
  const scope = currentBusinessScope();
  if (scope && value) {
    if (value.businessProfileId != null && value.businessProfileId !== scope.businessProfileId) throw new Error('INVALID_KNOWLEDGE_SCOPE');
    value = { ...value, businessProfileId:scope.businessProfileId };
  }
  if (!value || !['customer', 'internal'].includes(value.audience)
    || !['tenant', 'business_profile', 'staff_only'].includes(value.accessScope)
    || !Array.isArray(value.usageScopes) || !value.usageScopes.length
    || value.usageScopes.some(scope => !KNOWLEDGE_PURPOSES.includes(scope as typeof KNOWLEDGE_PURPOSES[number]))
    || !Array.isArray(value.allowedChannels) || value.allowedChannels.some(channel => !KNOWLEDGE_CHANNELS.includes(channel))
    || (value.businessProfileId !== null && (!Number.isSafeInteger(value.businessProfileId) || value.businessProfileId <= 0))
    || (value.accessScope === 'business_profile' && !value.businessProfileId)
    || (value.accessScope === 'staff_only' && value.audience !== 'internal')
    || (value.locale !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.locale))) {
    throw new Error('INVALID_KNOWLEDGE_SCOPE');
  }
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 255) throw new Error('INVALID_KNOWLEDGE_TITLE');
  if (value.sourceUrl) {
    let url: URL;
    try { url = new URL(value.sourceUrl); } catch { throw new Error('INVALID_KNOWLEDGE_SOURCE_URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_KNOWLEDGE_SOURCE_URL');
  }
  const privacy = scanKnowledgeContent(`${value.title}\n${value.sourceUrl || ''}`, { trustedBusinessContacts });
  if (privacy.mustQuarantine || privacy.containsPersonalData) throw new Error('KNOWLEDGE_METADATA_PRIVACY_REVIEW_REQUIRED');
  return { ...value, usageScopes: [...new Set(value.usageScopes)], allowedChannels: [...new Set(value.allowedChannels)] };
}
