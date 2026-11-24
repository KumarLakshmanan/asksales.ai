import { validateMSG91Settings, type MSG91SenderSettings } from '../../shared/msg91.js';
import { decryptChannelCredentialSecret, decryptChannelCredentialSession } from './channelCredentialSecrets.js';

interface SMSCredential {
  isActive?: boolean;
  credentialType?: string;
  accountIdentifier?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  sessionData?: unknown;
  providerVerifiedAt?: Date | string | null;
  readinessErrorCode?: string | null;
  encryptionVersion?: string | null;
  encryptionKeyId?: string | null;
  encryptedAt?: Date | string | null;
}

export function readMSG91Settings(credential: SMSCredential | null | undefined): MSG91SenderSettings {
  const value = decryptChannelCredentialSession(credential?.sessionData);
  const session = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const field = (key: string) => typeof session[key] === 'string' ? session[key].trim() : '';
  return {
    senderId: field('senderId') || credential?.apiKey?.trim() || '',
    flowId: field('flowId') || field('dltTemplateId'),
    messageVariable: field('messageVariable') || 'message',
  };
}

export function validMSG91AuthKey(value: string): boolean {
  return Boolean(value && value.length <= 1024 && !/[\r\n]/.test(value));
}

/** One readiness decision for settings, campaigns, chat tools, proposals, and sending. */
export function inspectMSG91Credential(credential: SMSCredential | null | undefined) {
  const settings = readMSG91Settings(credential);
  const authKey = decryptChannelCredentialSecret(credential?.apiSecret);
  const configured = Boolean(credential?.isActive && validMSG91AuthKey(authKey) && !validateMSG91Settings(settings));
  const verifiedAt = credential?.providerVerifiedAt ? new Date(credential.providerVerifiedAt) : null;
  const verified = Boolean(verifiedAt && Number.isFinite(verifiedAt.getTime()));
  const encryptionReady = Boolean(credential?.encryptionVersion && credential.encryptionKeyId && credential.encryptedAt);
  const senderBound = credential?.credentialType === 'api_key' && credential.accountIdentifier === settings.senderId;
  const ready = configured && verified && encryptionReady && senderBound && !credential?.readinessErrorCode;
  const issue = !credential ? 'Connect MSG91 in Integrations → SMS.'
    : !configured ? 'Complete the MSG91 Auth Key, Sender ID, Template ID, and message variable in Integrations → SMS.'
      : !encryptionReady ? 'Save the MSG91 connection again to protect the saved credentials before sending.'
        : !senderBound ? 'Save the MSG91 connection again to verify the selected sender before sending.'
        : credential.readinessErrorCode ? 'MSG91 verification needs attention. Test or update the connection in Integrations → SMS.'
        : !verified ? 'Verify the MSG91 sender and template in Integrations → SMS before sending.' : null;
  return { settings, configured, ready, issue };
}
