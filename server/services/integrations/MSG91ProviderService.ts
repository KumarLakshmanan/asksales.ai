import type { MSG91SenderSettings } from '../../../shared/msg91.js';
import { validateMSG91Settings } from '../../../shared/msg91.js';
import { validMSG91AuthKey } from '../../utils/msg91Credentials.js';
import { asRecord as record } from '../../../shared/records.js';

export interface MSG91VerificationResult {
  success: boolean;
  error?: string;
  code?: string;
  templateName?: string;
  providerRequestId?: string;
}

/** Inspect the actual template without sending an SMS or consuming messaging credits. */
export async function verifyMSG91Configuration(authKey: string, settings: MSG91SenderSettings): Promise<MSG91VerificationResult> {
  const invalid = validateMSG91Settings(settings);
  if (!validMSG91AuthKey(authKey) || invalid) {
    return { success: false, code: 'MSG91_CONFIG_INVALID', error: invalid || 'Enter a valid MSG91 Auth Key.' };
  }
  try {
    const response = await fetch('https://control.msg91.com/api/v5/sms/getTemplateVersions', {
      method: 'POST',
      headers: { authkey: authKey, accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: settings.flowId }),
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) {
      return { success: false, code: 'MSG91_AUTH_FAILED', error: 'MSG91 rejected the Auth Key. Check the key and its SMS API permissions.' };
    }
    const data = record(await response.json());
    // MSG91 also returns template/key errors with HTTP 200. A nonempty JSON body is not verification.
    if (!response.ok || data.status !== 'success' || data.hasError === true || !Array.isArray(data.data)) {
      return { success: false, code: 'MSG91_TEMPLATE_UNAVAILABLE', error: 'MSG91 could not verify this template. Check that the Auth Key and SMS Template ID belong to the same account.' };
    }
    const template = data.data.map(record).find(version => String(version.template_id) === settings.flowId
      && String(version.active_status) === '1' && String(version.status) === '1'
      && !version.reject_reason);
    if (!template) {
      return { success: false, code: 'MSG91_TEMPLATE_UNAVAILABLE', error: 'This MSG91 template has no active, accepted version. Complete template approval in MSG91 first.' };
    }
    if (String(template.sender_id) !== settings.senderId) {
      return { success: false, code: 'MSG91_SENDER_MISMATCH', error: 'The Sender ID does not match the active MSG91 template. Copy its Sender ID from MSG91.' };
    }
    const content = typeof template.template_data === 'string' ? template.template_data : '';
    const variables = [...new Set(Array.from(content.matchAll(/##([^#]+)##/g), match => match[1]))];
    if (variables.length !== 1 || variables[0] !== settings.messageVariable) {
      return { success: false, code: 'MSG91_TEMPLATE_VARIABLES', error: `Use an SMS template with exactly one text variable named ${settings.messageVariable}. Variable names are case-sensitive.` };
    }
    return {
      success: true,
      templateName: typeof template.template_name === 'string' ? template.template_name : undefined,
      providerRequestId: response.headers.get('x-request-id') || undefined,
    };
  } catch {
    return { success: false, code: 'MSG91_PROVIDER_UNAVAILABLE', error: 'MSG91 verification is unavailable. Please try again.' };
  }
}

export async function getMSG91Balance(authKey: string): Promise<{ success: boolean; balance?: number; error?: string }> {
  if (!validMSG91AuthKey(authKey)) return { success: false, error: 'MSG91 Auth Key is missing or invalid.' };
  try {
    // The documented route-balance API requires authkey and type in its query.
    // Never log this URL or the provider's raw response, which can include credentials.
    const url = new URL('https://api.msg91.com/api/balance.php');
    url.searchParams.set('authkey', authKey);
    url.searchParams.set('type', '4');
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000), redirect: 'error' });
    const value = (await response.text()).trim();
    if (response.ok && /^\d+(?:\.\d+)?$/.test(value)) {
      const balance = Number(value);
      if (Number.isFinite(balance)) return { success: true, balance };
    }
    return { success: false, error: 'MSG91 could not return the SMS route balance. Check your account in MSG91.' };
  } catch {
    return { success: false, error: 'MSG91 balance is unavailable. Please try again.' };
  }
}
