export interface MSG91SenderSettings {
  senderId: string;
  flowId: string;
  messageVariable: string;
}

export interface MSG91PublicSettings extends MSG91SenderSettings {
  /** Compatibility with settings saved before the Template ID field was renamed. */
  dltTemplateId?: string;
  hasAuthKey: boolean;
  lastUsedAt?: string | null;
  lastVerifiedAt?: string | null;
  connectionStatus?: 'ready' | 'action_required' | 'reauth_required';
  readinessErrorCode?: string | null;
  readinessMessage?: string | null;
  templateName?: string | null;
}

export interface MSG91SettingsResponse {
  success: boolean;
  configured: boolean;
  connected?: boolean;
  settings: MSG91PublicSettings | null;
}

const RESERVED_VARIABLES = new Set(['mobiles', 'crqid', 'uuid', 'clientid', 'inmsid', 'constructor', 'prototype']);

export function validateMSG91Settings(settings: MSG91SenderSettings): string | null {
  if (!/^[A-Z0-9]{6}$/.test(settings.senderId)) {
    return 'Sender ID must be exactly 6 uppercase letters or numbers.';
  }
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(settings.flowId)) {
    return 'Enter the MSG91 SMS Template ID from your approved template.';
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(settings.messageVariable)
    || RESERVED_VARIABLES.has(settings.messageVariable.toLowerCase())) {
    return 'Enter a message variable using letters, numbers, or underscores. Provider routing and tracking field names are reserved.';
  }
  return null;
}

/** MSG91 expects international digits without a leading +. Local Indian numbers have 10 digits. */
export function normalizeMSG91Phone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  if (!/^(?:\+|00)?[0-9]+$/.test(compact)) return null;
  const international = compact.startsWith('+') || compact.startsWith('00');
  let digits = compact.replace(/^(?:\+|00)/, '');
  if (!international && digits.length === 10) digits = `91${digits}`;
  if (!international && digits.length < 11) return null;
  return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
}
