const templateCategories = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
const headerTypes = new Set(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);
const buttonTypes = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']);

export type TemplateButton = { type: string; text: string; url?: string | null; phone_number?: string | null };

function variableIndexes(value: string): number[] {
  return [...new Set(Array.from(value.matchAll(/{{\s*(\d+)\s*}}/g), (match) => Number(match[1])))]
    .sort((left, right) => left - right);
}

function variableStructureError(value: string, label: string): string | null {
  if (/{{|}}/.test(value.replace(/{{\s*\d+\s*}}/g, ''))) {
    return `${label} variables must use numbered placeholders such as {{1}}`;
  }
  const indexes = variableIndexes(value);
  if (indexes.some((index, position) => index !== position + 1)) {
    return `${label} variables must start at {{1}} and continue without gaps`;
  }
  return null;
}

export type AuthenticationConfig = { otpType: 'COPY_CODE' | 'ONE_TAP'; buttonText: string; autofillText?: string; packageName?: string; signatureHash?: string; codeExpirationMinutes: number; addSecurityRecommendation: boolean };

export function validateWhatsAppTemplateInput(value: unknown, options: { draftOnly?: boolean } = {}): { error?: string; data?: {
  name: string; language: string; category: string; body: string; header: string | null;
  headerType: string; headerMediaUrl: string | null; footer: string | null; buttons: TemplateButton[] | null;
  examples: Record<string, string> | null; variableLabels: Record<string, string> | null; authConfig: AuthenticationConfig | null;
} } {
  if (!value || typeof value !== 'object') return { error: 'Template payload is required' };
  const input = value as Record<string, unknown>;
  const draftOnly = options.draftOnly === true;
  for (const key of ['name','language','category','body','header','headerType','headerMediaUrl','footer']) {
    if (input[key] != null && typeof input[key] !== 'string') return { error: `${key} must be text` };
  }
  if (Array.isArray(value)) return { error: 'Template payload must be an object' };
  const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const language = typeof input.language === 'string' ? input.language.trim() : 'en_US';
  const category = typeof input.category === 'string' ? input.category.trim().toUpperCase() : 'MARKETING';
  const header = typeof input.header === 'string' && input.header.trim() ? input.header.trim() : null;
  const headerType = typeof input.headerType === 'string' ? input.headerType.trim().toUpperCase() : header ? 'TEXT' : 'NONE';
  const headerMediaUrl = typeof input.headerMediaUrl === 'string' && input.headerMediaUrl.trim() ? input.headerMediaUrl.trim() : null;
  const footer = typeof input.footer === 'string' && input.footer.trim() ? input.footer.trim() : null;

  if (!name || !/^[a-z0-9_]+$/.test(name) || name.length > 255) return { error: 'Name must use lowercase letters, numbers, and underscores only' };
  if ((!draftOnly && category !== 'AUTHENTICATION' && !body) || body.length > 1024) return { error: 'Body is required and must be 1024 characters or fewer' };
  if (!language || language.length > 50) return { error: 'A valid language is required' };
  if (!templateCategories.has(category)) return { error: 'Category must be MARKETING, UTILITY, or AUTHENTICATION' };
  if (!headerTypes.has(headerType)) return { error: 'Unsupported header type' };
  if (header && header.length > 60) return { error: 'Header must be 60 characters or fewer' };
  if (headerMediaUrl && headerMediaUrl.length > 8192) return { error: 'Header media reference is too long' };
  if (footer && footer.length > 60) return { error: 'Footer must be 60 characters or fewer' };
  if (!draftOnly && headerType === 'TEXT' && !header) return { error: 'Text headers require header text' };
  const headerVariableError = variableStructureError(headerType === 'TEXT' ? header || '' : '', 'Header');
  if (!draftOnly && headerVariableError) return { error: headerVariableError };
  const bodyVariableError = variableStructureError(body, 'Body');
  if (!draftOnly && category !== 'AUTHENTICATION' && bodyVariableError) return { error: bodyVariableError };

  let buttons: TemplateButton[] | null = null;
  if (input.buttons != null) {
    if (!Array.isArray(input.buttons) || input.buttons.length > 3) return { error: 'Buttons must be an array with no more than 3 items' };
    buttons = [];
    for (const rawButton of input.buttons) {
      if (!rawButton || typeof rawButton !== 'object') return { error: 'Each button must be an object' };
      const button = rawButton as Record<string, unknown>;
      const type = typeof button.type === 'string' ? button.type.trim().toUpperCase() : '';
      const text = typeof button.text === 'string' ? button.text.trim() : '';
      const url = typeof button.url === 'string' && button.url.trim() ? button.url.trim() : null;
      const phoneNumber = typeof button.phone_number === 'string' && button.phone_number.trim() ? button.phone_number.trim() : null;
      if (!buttonTypes.has(type)) return { error: 'Unsupported button type' };
      if ((!draftOnly && !text) || text.length > 25) return { error: 'Button text is required and must be 25 characters or fewer' };
      if (url && url.length > 2048) return { error: 'Button URLs must be 2048 characters or fewer' };
      if (phoneNumber && phoneNumber.length > 24) return { error: 'Phone numbers must be 24 characters or fewer' };
      if (!draftOnly && type === 'URL') {
        try {
          const parsed = new URL(url || '');
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
        } catch { return { error: 'URL buttons require a valid http or https URL' }; }
      }
      if (!draftOnly && type === 'PHONE_NUMBER' && (!phoneNumber || !/^\+?[0-9 ()-]{7,24}$/.test(phoneNumber))) return { error: 'Phone buttons require a valid phone number' };
      buttons.push({
        type,
        text,
        url: type === 'URL' ? url : null,
        phone_number: type === 'PHONE_NUMBER' ? phoneNumber : null,
      });
    }
  }

  let examples: Record<string, string> | null = null;
  if (input.examples != null) {
    if (!input.examples || typeof input.examples !== 'object' || Array.isArray(input.examples)) {
      return { error: 'Variable examples must be an object' };
    }
    examples = {};
    for (const [key, rawExample] of Object.entries(input.examples as Record<string, unknown>)) {
      const match = key.match(/^(?:(header|body):)?(\d+)$/);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 100) return { error: 'Variable example keys must be positive numbers, optionally prefixed with header: or body:' };
      if (typeof rawExample !== 'string' || (!draftOnly && !rawExample.trim()) || rawExample.trim().length > 1024) {
        return { error: 'Each variable example is required and must be 1024 characters or fewer' };
      }
      const normalizedKey = match[1] ? `${match[1]}:${Number(match[2])}` : String(Number(match[2]));
      examples[normalizedKey] = rawExample.trim();
    }
    if (Object.keys(examples).length > 20) return { error: 'No more than 20 variable examples are supported' };
  }

  const missingExample = (component: 'header' | 'body', index: number) =>
    !examples?.[`${component}:${index}`]?.trim() && !examples?.[String(index)]?.trim();
  if (!draftOnly && variableIndexes(headerType === 'TEXT' ? header || '' : '').some((index) => missingExample('header', index))) {
    return { error: 'Add an example for every header variable' };
  }
  if (!draftOnly && category !== 'AUTHENTICATION' && variableIndexes(body).some((index) => missingExample('body', index))) {
    return { error: 'Add an example for every body variable' };
  }

  let variableLabels: Record<string, string> | null = null;
  if (input.variableLabels != null) {
    if (typeof input.variableLabels !== 'object' || Array.isArray(input.variableLabels)) return { error: 'Variable labels must be an object' };
    variableLabels = {};
    for (const [key, label] of Object.entries(input.variableLabels as Record<string, unknown>)) {
      if (!/^(?:(header|body):)?([1-9]\d?)$/.test(key) || typeof label !== 'string' || label.length > 80) return { error: 'Variable labels require numbered keys and text up to 80 characters' };
      variableLabels[key] = label.trim();
    }
    if (Object.keys(variableLabels).length > 20) return { error: 'No more than 20 variable labels are supported' };
  }
  let authConfig: AuthenticationConfig | null = null;
  if (category === 'AUTHENTICATION' && input.authConfig != null) {
    if (typeof input.authConfig !== 'object' || Array.isArray(input.authConfig)) return { error: 'Authentication settings must be an object' };
    const raw = input.authConfig as Record<string, unknown>;
    if (!['COPY_CODE', 'ONE_TAP'].includes(String(raw.otpType))) return { error: 'Choose a supported OTP button type' };
    if (typeof raw.addSecurityRecommendation !== 'boolean') return { error: 'Security recommendation must be a boolean' };
    if (!Number.isInteger(raw.codeExpirationMinutes) || Number(raw.codeExpirationMinutes) < 1 || Number(raw.codeExpirationMinutes) > 90) return { error: 'Code expiration must be between 1 and 90 minutes' };
    const buttonText = typeof raw.buttonText === 'string' ? raw.buttonText.trim() : '';
    const autofillText = typeof raw.autofillText === 'string' ? raw.autofillText.trim() : '';
    const packageName = typeof raw.packageName === 'string' ? raw.packageName.trim() : '';
    const signatureHash = typeof raw.signatureHash === 'string' ? raw.signatureHash.trim() : '';
    if ((!draftOnly && !buttonText) || buttonText.length > 25 || autofillText.length > 25 || packageName.length > 224 || signatureHash.length > 11) return { error: 'OTP labels must be 25 characters or fewer, package name 224, and signing hash 11' };
    if (!draftOnly && raw.otpType === 'ONE_TAP' && (!autofillText || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName) || !/^[a-zA-Z0-9+/=]{11}$/.test(signatureHash))) return { error: 'One-tap authentication requires an autofill label, valid Android package name and 11-character signing hash' };
    authConfig = { otpType: raw.otpType as AuthenticationConfig['otpType'], buttonText, codeExpirationMinutes: Number(raw.codeExpirationMinutes), addSecurityRecommendation: raw.addSecurityRecommendation,
      ...(raw.otpType === 'ONE_TAP' ? { autofillText, packageName, signatureHash } : {}) };
  }
  if (!draftOnly && category === 'AUTHENTICATION' && !authConfig) return { error: 'Authentication templates require OTP settings' };
  if (category === 'AUTHENTICATION' && (headerType !== 'NONE' || header || headerMediaUrl || (buttons?.length ?? 0) > 0)) return { error: 'Authentication templates use preset OTP content and cannot include headers, media or regular buttons' };
  const isMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType);
  return { data: { name, language, category, body, header: headerType === 'TEXT' ? header : null, headerType, headerMediaUrl: isMediaHeader ? headerMediaUrl : null, footer, buttons, examples, variableLabels, authConfig } };
}
