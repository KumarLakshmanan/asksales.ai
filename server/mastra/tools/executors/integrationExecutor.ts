import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { db } from '../../../models/db.js';
import { channelCredentialsTable } from '../../../models/channelCredentials/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../../utils/logger.js';
import { metaAccountChoices, googleAccountChoices } from '../adAccountChoices.js';
import { toNumber } from './executorValues.js';

export async function executeCheckIntegrationStatus(
  input: {
    platform: 'email' | 'sms' | 'whatsapp' | 'instagram' | 'facebook' | 'linkedin' | 'twitter' | 'meta_ads' | 'google_ads' | 'youtube';
  },
  context: ToolContext
): Promise<ToolResult> {
  const userIdNum = toNumber(context.userId);
  const platform = input.platform;

  try {
    let connected = false;
    let details: string | undefined;
    let accountSelection: ReturnType<typeof metaAccountChoices> | undefined;

    switch (platform) {
      case 'email': {
        const { GmailApiService } = await import('../../../services/gmailApiService.js');
        const { getVerifiedDomain } = await import('../../../services/resendService.js');
        const hasGmail = await GmailApiService.getInstance().isConnected(userIdNum);
        let hasResend = false;
        try {
          const domain = await getVerifiedDomain(userIdNum);
          hasResend = !!domain;
        // eslint-disable-next-line no-empty
        } catch {}
        
        connected = hasGmail || hasResend;
        details = connected 
          ? `Connected via ${hasGmail ? 'Gmail OAuth' : ''}${hasGmail && hasResend ? ' and ' : ''}${hasResend ? 'Resend API' : ''}.`
          : 'Neither Gmail nor Resend is connected.';
        break;
      }

      case 'sms': {
        const { ChannelCredentialModel } = await import('../../../models/channelCredentials/functions.js');
        const { inspectMSG91Credential } = await import('../../../utils/msg91Credentials.js');
        const readiness = inspectMSG91Credential(await ChannelCredentialModel.findByUserAndPlatform(userIdNum, 'msg91_sms'));
        connected = readiness.ready;
        details = connected ? `Connected (Sender ID: ${readiness.settings.senderId}, Template ID: ${readiness.settings.flowId}).` : readiness.issue || 'MSG91 SMS not connected.';
        break;
      }

      case 'whatsapp': {
        const { whatsappApiService } = await import('../../../services/whatsappApiService.js');
        const waCreds = await whatsappApiService.resolveCreds(userIdNum);
        connected = !!waCreds;
        // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
        details = connected ? `Connected (Phone Number ID: ${waCreds.phoneNumberId}).` : 'WhatsApp Business API not connected.';
        break;
      }

      case 'linkedin': {
        const { hasLinkedInApiCredentials } = await import('../../../services/LinkedInApiService.js');
        connected = await hasLinkedInApiCredentials(userIdNum);
        details = connected ? 'Connected.' : 'LinkedIn integration not connected.';
        break;
      }

      case 'twitter': {
        const [twitterCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'twitter'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        const [twitterCredApi] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'twitter_api'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        connected = !!(twitterCred || twitterCredApi);
        details = connected ? 'Connected.' : 'Twitter/X integration not connected.';
        break;
      }

      case 'facebook': {
        const [fbCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'facebook'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        const [fbCredApi] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'facebook_api'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        connected = !!(fbCred || fbCredApi);
        details = connected ? 'Connected.' : 'Facebook integration not connected.';
        break;
      }

      case 'instagram': {
        const [igCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'instagram'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        const [igCredApi] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'instagram_api'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        connected = !!(igCred || igCredApi);
        details = connected ? 'Connected.' : 'Instagram integration not connected.';
        break;
      }

      case 'meta_ads': {
        const { getMetaAdsCreds } = await import('../../../models/metaPageConnections/functions.js');
        const { getCredential } = await import('../../../services/credentialService.js');
        const creds = await getMetaAdsCreds(userIdNum);
        const stored = await getCredential(userIdNum, 'meta_ads');
        accountSelection = metaAccountChoices(stored?.config, creds);
        connected = Boolean(creds?.accessToken || stored?.config?.accessToken);
        details = connected ? 'Saved Meta authorization found. Account selection and live provider readiness must still be checked.' : 'Meta Ads not connected.';
        break;
      }

      case 'google_ads': {
        const { getGoogleAdsCredentials } = await import('../../../controllers/integrationsController.js');
        const googleCreds = await getGoogleAdsCredentials(userIdNum);
        accountSelection = googleAccountChoices(googleCreds);
        connected = !!(googleCreds && googleCreds.clientId && googleCreds.customerId && googleCreds.developerToken && googleCreds.refreshToken);
        // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
        details = connected ? `Connected (Customer ID: ${googleCreds.customerId}).` : 'Google Ads not connected.';
        break;
      }

      case 'youtube': {
        // YouTube uses Google credentials/OAuth
        const [ytCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'youtube'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        const [googleCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, userIdNum),
            eq(channelCredentialsTable.platform, 'google'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        connected = !!(ytCred || googleCred);
        details = connected ? 'Connected.' : 'YouTube integration not connected.';
        break;
      }

      default:
        return {
          success: false,
          toolName: 'check_integration_status',
          error: `Unsupported platform: ${platform}`,
        };
    }

    return {
      success: true,
      toolName: 'check_integration_status',
      output: {
        platform,
        connected,
        ...(accountSelection ? { accountSelection } : {}),
        message: connected 
          ? `✅ Platform ${platform} is connected. ${details}`
          : `❌ Platform ${platform} is NOT connected. Please connect it in Settings → Integrations.`,
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, platform }, '[Integration Executor] check_integration_status error');
    return {
      success: false,
      toolName: 'check_integration_status',
      error: error.message || `Failed to check status for ${platform}`,
    };
  }
}
