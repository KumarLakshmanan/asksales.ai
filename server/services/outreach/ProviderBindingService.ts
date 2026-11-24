import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { adminApiCredentialsTable } from '../../models/adminApiCredentials/schema.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import { resendDomainsTable } from '../../models/resendDomains/schema.js';
import { getMetaAppReviewPermissions, type MetaPermission } from '../integrations/MetaCapabilityRegistry.js';
import { ChannelCredentialModel } from '../../models/channelCredentials/functions.js';
import { inspectMSG91Credential } from '../../utils/msg91Credentials.js';
import { decryptChannelCredentialSecret, encryptChannelCredentialSecret, getChannelCredentialEncryptionKeyId } from '../../utils/channelCredentialSecrets.js';
import { logger } from '../../utils/logger.js';

export type OfficialSocialChannel = 'instagram' | 'facebook' | 'twitter' | 'linkedin';
export type OfficialProviderChannel = OfficialSocialChannel | 'whatsapp' | 'email' | 'sms';
export type EmailProviderVariant = 'gmail' | 'resend';
export type OfficialCredentialPlatform =
  | 'instagram_api'
  | 'facebook_api'
  | 'twitter_api'
  | 'linkedin_api'
  | 'whatsapp'
  | 'gmail_api'
  | 'resend_api'
  | 'msg91_sms';

export interface ProviderBinding {
  credentialId: number;
  platform: OfficialCredentialPlatform;
  providerAccountId: string;
  accountName?: string;
  providerVariant?: EmailProviderVariant;
}

export interface ProviderReadiness {
  ready: boolean;
  code: 'OFFICIAL_PROVIDER_READY' | 'OFFICIAL_PROVIDER_NOT_READY';
  channel: OfficialProviderChannel;
  credentialPlatform: OfficialCredentialPlatform;
  providerVariant?: EmailProviderVariant;
  missing: string[];
  credentialValuesExposed: false;
  binding?: ProviderBinding;
}

interface ResolveOptions {
  providerVariant?: EmailProviderVariant;
  credentialId?: number;
  providerAccountId?: string;
}

interface Requirement {
  credentialPlatform: OfficialCredentialPlatform;
  credentialTypes: string[];
  requiredScopeSets: string[][];
  approvalRequired: boolean;
  apiVersionRequired: boolean;
}

const REQUIREMENTS: Record<Exclude<OfficialProviderChannel, 'email' | 'sms'>, Requirement> = {
  facebook: {
    credentialPlatform: 'facebook_api',
    credentialTypes: ['oauth', 'manual'],
    requiredScopeSets: [['pages_messaging']],
    approvalRequired: true,
    apiVersionRequired: true,
  },
  instagram: {
    credentialPlatform: 'instagram_api',
    credentialTypes: ['oauth', 'manual'],
    requiredScopeSets: [['instagram_basic', 'instagram_manage_messages', 'pages_show_list', 'pages_read_engagement']],
    approvalRequired: true,
    apiVersionRequired: true,
  },
  whatsapp: {
    credentialPlatform: 'whatsapp',
    credentialTypes: ['oauth', 'api_key', 'manual'],
    requiredScopeSets: [['whatsapp_business_messaging']],
    approvalRequired: true,
    apiVersionRequired: true,
  },
  twitter: {
    credentialPlatform: 'twitter_api',
    credentialTypes: ['oauth'],
    requiredScopeSets: [['dm.write', 'dm.read', 'tweet.read', 'users.read']],
    approvalRequired: true,
    apiVersionRequired: false,
  },
  linkedin: {
    credentialPlatform: 'linkedin_api',
    credentialTypes: ['oauth'],
    requiredScopeSets: [],
    approvalRequired: true,
    apiVersionRequired: true,
  },
};

const EMAIL_REQUIREMENTS: Record<EmailProviderVariant, Requirement> = {
  gmail: {
    credentialPlatform: 'gmail_api',
    credentialTypes: ['oauth'],
    // users.messages.send accepts any of these granted capabilities. Keep the
    // provider's actual scopes; never manufacture a narrower gmail.send grant.
    requiredScopeSets: [
      ['https://www.googleapis.com/auth/gmail.send'],
      ['https://www.googleapis.com/auth/gmail.compose'],
      ['https://www.googleapis.com/auth/gmail.modify'],
      ['https://mail.google.com/'],
    ],
    approvalRequired: true,
    apiVersionRequired: false,
  },
  resend: {
    credentialPlatform: 'resend_api',
    credentialTypes: ['api_key'],
    requiredScopeSets: [],
    approvalRequired: false,
    apiVersionRequired: false,
  },
};

function requirementFor(
  channel: Exclude<OfficialProviderChannel, 'sms'>,
  providerVariant?: EmailProviderVariant,
): Requirement {
  if (channel !== 'email') return REQUIREMENTS[channel];
  if (!providerVariant) {
    throw new Error('Email provider variant is required for readiness checks');
  }
  return EMAIL_REQUIREMENTS[providerVariant];
}

function scopeSetSatisfied(granted: string[], requiredSets: string[][]): boolean {
  return requiredSets.length === 0
    || requiredSets.some((candidate) => candidate.every((scope) => granted.includes(scope)));
}

/** Older Gmail OAuth callbacks saved usable tokens but omitted outreach readiness metadata. */
async function repairLegacyGmailBinding(userId: number, options: ResolveOptions): Promise<void> {
  const credential = options.credentialId
    ? await ChannelCredentialModel.findActiveAccountById(userId, 'gmail_api', options.credentialId)
    : options.providerAccountId
      ? await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'gmail_api', options.providerAccountId)
      : await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
  if (!credential || !credential.accountIdentifier || credential.credentialType !== 'oauth') return;
  if (options.providerAccountId && credential.accountIdentifier !== options.providerAccountId) return;
  const metadataReady = Boolean(credential.encryptionVersion && credential.encryptionKeyId && credential.encryptedAt
    && scopeSetSatisfied(Array.isArray(credential.grantedScopes) ? credential.grantedScopes : [], EMAIL_REQUIREMENTS.gmail.requiredScopeSets)
    && credential.providerApprovalStatus === 'approved' && credential.providerVerifiedAt
    && !credential.readinessErrorCode);
  if (metadataReady && (!credential.tokenExpiry || new Date(credential.tokenExpiry).getTime() > Date.now())) return;

  try {
    const [{ getGmailClientForUser }, { google }] = await Promise.all([
      import('../../controllers/gmailOAuthController.js'),
      import('googleapis'),
    ]);
    const result = await getGmailClientForUser(userId, {
      credentialId: credential.id,
      accountIdentifier: credential.accountIdentifier,
    });
    if (!result?.client.credentials.access_token) return;
    if (metadataReady) return;
    const [tokenInfo, profile] = await Promise.all([
      result.client.getTokenInfo(result.client.credentials.access_token),
      google.gmail({ version: 'v1', auth: result.client }).users.getProfile({ userId: 'me' }),
    ]);
    const scopes = Array.isArray(tokenInfo.scopes) ? tokenInfo.scopes : [];
    if (!scopeSetSatisfied(scopes, EMAIL_REQUIREMENTS.gmail.requiredScopeSets)
      || profile.data.emailAddress?.trim().toLowerCase() !== credential.accountIdentifier.trim().toLowerCase()) return;
    const current = result.credential;
    await ChannelCredentialModel.updateAccount(userId, 'gmail_api', credential.id, {
      accessToken: encryptChannelCredentialSecret(result.client.credentials.access_token),
      refreshToken: encryptChannelCredentialSecret(result.client.credentials.refresh_token || decryptChannelCredentialSecret(current.refreshToken)),
      encryptionVersion: 'secrets-manager-v1',
      encryptionKeyId: getChannelCredentialEncryptionKeyId(),
      encryptedAt: new Date(),
      grantedScopes: scopes,
      providerApprovalStatus: 'approved',
      providerVerifiedAt: new Date(),
      lastReadinessCheckAt: new Date(),
      readinessErrorCode: null,
    });
  } catch (error) {
    logger.warn({ err: error, userId, credentialId: credential.id }, '[ProviderBinding] Gmail readiness repair failed');
  }
}

async function inspectResendBinding(
  userId: number,
  options: ResolveOptions,
): Promise<ProviderReadiness> {
  const credentialPredicates = [
    eq(adminApiCredentialsTable.platform, 'resend'),
    eq(adminApiCredentialsTable.isActive, true),
  ];
  if (options.credentialId) {
    credentialPredicates.push(eq(adminApiCredentialsTable.id, options.credentialId));
  }
  const domainPredicates = [
    eq(resendDomainsTable.userId, userId),
    eq(resendDomainsTable.status, 'verified'),
  ];
  if (options.providerAccountId) {
    domainPredicates.push(eq(resendDomainsTable.name, options.providerAccountId));
  }
  const [[credential], [domain]] = await Promise.all([
    db.select({
      id: adminApiCredentialsTable.id,
      hasCredentialMaterial: sql<boolean>`${adminApiCredentialsTable.apiKey} IS NOT NULL AND ${adminApiCredentialsTable.apiKey} <> ''`,
      isEncrypted: adminApiCredentialsTable.isEncrypted,
      validationStatus: adminApiCredentialsTable.validationStatus,
      lastValidatedAt: adminApiCredentialsTable.lastValidatedAt,
    })
      .from(adminApiCredentialsTable)
      .where(and(...credentialPredicates))
      .orderBy(desc(adminApiCredentialsTable.lastValidatedAt), desc(adminApiCredentialsTable.id))
      .limit(1),
    db.select({
      id: resendDomainsTable.id,
      name: resendDomainsTable.name,
    })
      .from(resendDomainsTable)
      .where(and(...domainPredicates))
      .orderBy(desc(resendDomainsTable.updatedAt), desc(resendDomainsTable.id))
      .limit(1),
  ]);

  const missing: string[] = [];
  if (!credential) missing.push('operator_credential');
  if (credential && !credential.hasCredentialMaterial) missing.push('credential_material');
  if (credential && !credential.isEncrypted) missing.push('encryption_metadata');
  if (
    credential
    && (credential.validationStatus !== 'valid' || !credential.lastValidatedAt)
  ) {
    missing.push('provider_verification');
  }
  if (!domain) missing.push('verified_tenant_domain');

  const binding = credential && domain && missing.length === 0
    ? {
        credentialId: credential.id,
        platform: 'resend_api' as const,
        providerAccountId: domain.name,
        providerVariant: 'resend' as const,
      }
    : undefined;
  return {
    ready: Boolean(binding),
    code: binding ? 'OFFICIAL_PROVIDER_READY' : 'OFFICIAL_PROVIDER_NOT_READY',
    channel: 'email',
    credentialPlatform: 'resend_api',
    providerVariant: 'resend',
    missing: [...new Set(missing)].sort(),
    credentialValuesExposed: false,
    binding,
  };
}

/**
 * Inspect only non-secret readiness metadata. The query returns a boolean for
 * secret material and never returns accessToken/apiKey/sessionData values.
 */
export async function inspectOfficialProviderBinding(
  userId: number,
  channel: OfficialProviderChannel,
  options: ResolveOptions = {},
): Promise<ProviderReadiness> {
  if (channel === 'sms') {
    const credential = options.credentialId
      ? await ChannelCredentialModel.findActiveAccountById(userId, 'msg91_sms', options.credentialId)
      : options.providerAccountId
        ? await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'msg91_sms', options.providerAccountId)
        : await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');
    const readiness = inspectMSG91Credential(credential);
    const ready = readiness.ready && credential?.credentialType === 'api_key'
      && credential.accountIdentifier === readiness.settings.senderId
      && (!options.providerAccountId || credential.accountIdentifier === options.providerAccountId);
    const binding: ProviderBinding | undefined = ready && credential ? {
      credentialId: credential.id, platform: 'msg91_sms',
      providerAccountId: readiness.settings.senderId, accountName: credential.accountName || undefined,
    } : undefined;
    return {
      ready: Boolean(binding), code: binding ? 'OFFICIAL_PROVIDER_READY' : 'OFFICIAL_PROVIDER_NOT_READY',
      channel, credentialPlatform: 'msg91_sms', missing: binding ? [] : ['sms_connection'],
      credentialValuesExposed: false, binding,
    };
  }
  if (channel === 'email' && options.providerVariant === 'resend') {
    return inspectResendBinding(userId, options);
  }
  if (channel === 'email' && options.providerVariant === 'gmail') {
    await repairLegacyGmailBinding(userId, options);
  }
  const requirement = requirementFor(channel, options.providerVariant);
  const predicates = [
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.platform, requirement.credentialPlatform),
    eq(channelCredentialsTable.isActive, true),
  ];
  if (options.credentialId) {
    predicates.push(eq(channelCredentialsTable.id, options.credentialId));
  }
  if (options.providerAccountId) {
    predicates.push(eq(channelCredentialsTable.accountIdentifier, options.providerAccountId));
  }

  const credentials = await db.select({
    id: channelCredentialsTable.id,
    credentialType: channelCredentialsTable.credentialType,
    usesInstagramLogin: sql<boolean>`COALESCE(${channelCredentialsTable.sessionData}->>'useInstagramLogin' = 'true', false)`,
    hasCredentialMaterial: sql<boolean>`(
      (${channelCredentialsTable.accessToken} IS NOT NULL AND ${channelCredentialsTable.accessToken} <> '')
      OR (${channelCredentialsTable.apiKey} IS NOT NULL AND ${channelCredentialsTable.apiKey} <> '')
    )`,
    tokenExpiry: channelCredentialsTable.tokenExpiry,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
    accountName: channelCredentialsTable.accountName,
    encryptionVersion: channelCredentialsTable.encryptionVersion,
    encryptionKeyId: channelCredentialsTable.encryptionKeyId,
    encryptedAt: channelCredentialsTable.encryptedAt,
    grantedScopes: channelCredentialsTable.grantedScopes,
    providerApprovalStatus: channelCredentialsTable.providerApprovalStatus,
    providerApiVersion: channelCredentialsTable.providerApiVersion,
    providerVerifiedAt: channelCredentialsTable.providerVerifiedAt,
    readinessErrorCode: channelCredentialsTable.readinessErrorCode,
  })
    .from(channelCredentialsTable)
    .where(and(...predicates))
    .orderBy(
      desc(channelCredentialsTable.isSelected),
      desc(channelCredentialsTable.providerVerifiedAt),
      desc(channelCredentialsTable.id),
    )
    .limit(!['facebook', 'instagram'].includes(channel) || options.credentialId || options.providerAccountId ? 1 : 2);

  const ambiguous = ['facebook', 'instagram'].includes(channel) && credentials.length > 1 && !options.credentialId && !options.providerAccountId;
  const credential = ambiguous ? undefined : credentials[0];
  const missing: string[] = ambiguous ? ['account_selection'] : [];
  const metaReviewScope: MetaPermission | null = channel === 'facebook'
    ? 'pages_messaging'
    : channel === 'instagram'
      ? credential?.usesInstagramLogin === true ? 'instagram_business_manage_messages' : 'instagram_manage_messages'
      : channel === 'whatsapp'
        ? 'whatsapp_business_messaging'
        : null;
  const metaReview = metaReviewScope ? await getMetaAppReviewPermissions() : null;
  if (!credential) {
    missing.push('credential');
  } else {
    if (!requirement.credentialTypes.includes(credential.credentialType)) {
      missing.push('credential_type');
    }
    if (!credential.hasCredentialMaterial) missing.push('credential_material');
    if (
      credential.tokenExpiry
      && new Date(credential.tokenExpiry).getTime() <= Date.now()
    ) {
      missing.push('unexpired_token');
    }
    if (!credential.accountIdentifier) missing.push('account_reference');
    if (
      !credential.encryptionVersion
      || !credential.encryptionKeyId
      || !credential.encryptedAt
    ) {
      missing.push('encryption_metadata');
    }
    const grantedScopes = Array.isArray(credential.grantedScopes)
      ? credential.grantedScopes.filter((scope: unknown): scope is string => typeof scope === 'string')
      : [];
    if (!scopeSetSatisfied(grantedScopes, channel === 'instagram' && credential?.usesInstagramLogin === true ? [['instagram_business_basic', 'instagram_business_manage_messages']] : requirement.requiredScopeSets)) {
      missing.push('required_scopes');
    }
    if (
      requirement.approvalRequired
      && (metaReviewScope
        ? !['approved', 'not_required'].includes(metaReview?.[metaReviewScope] || 'unknown')
        : credential.providerApprovalStatus !== 'approved')
    ) {
      missing.push('provider_approval');
    }
    if (
      !requirement.approvalRequired
      && !['approved', 'not_required'].includes(credential.providerApprovalStatus)
    ) {
      missing.push('provider_approval_metadata');
    }
    if (requirement.apiVersionRequired && !credential.providerApiVersion) {
      missing.push('api_version');
    }
    if (!credential.providerVerifiedAt) missing.push('provider_verification');
    if (credential.readinessErrorCode) missing.push('readiness_error');
  }

  const binding = credential && missing.length === 0
    ? {
        credentialId: credential.id,
        platform: requirement.credentialPlatform,
        providerAccountId: credential.accountIdentifier!,
        accountName: credential.accountName || undefined,
        providerVariant: options.providerVariant,
      }
    : undefined;

  return {
    ready: Boolean(binding),
    code: binding ? 'OFFICIAL_PROVIDER_READY' : 'OFFICIAL_PROVIDER_NOT_READY',
    channel,
    credentialPlatform: requirement.credentialPlatform,
    providerVariant: options.providerVariant,
    missing: [...new Set(missing)].sort(),
    credentialValuesExposed: false,
    binding,
  };
}

export async function resolveOfficialProviderBinding(
  userId: number,
  channel: OfficialProviderChannel,
  options: ResolveOptions = {},
): Promise<ProviderBinding | null> {
  const readiness = await inspectOfficialProviderBinding(userId, channel, options);
  return readiness.binding || null;
}

export async function resolveOfficialSocialProviderBinding(
  userId: number,
  channel: OfficialSocialChannel,
  options: ResolveOptions = {},
): Promise<ProviderBinding | null> {
  return resolveOfficialProviderBinding(userId, channel, options);
}
