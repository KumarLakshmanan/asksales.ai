export const SMS_MESSAGE_LIMIT = 160;

function trimAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sentence = value.slice(0, maxLength).match(/^.*[.!?](?=\s|$)/);
  if (sentence && sentence[0].length >= maxLength * 0.5) return sentence[0];
  if (maxLength < 4) return ''.padEnd(maxLength, '.');
  const shortened = value.slice(0, maxLength - 2);
  const boundary = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, boundary > Math.floor(maxLength * 0.6) ? boundary : maxLength - 3).trim()}...`;
}

export function normalizeSmsMessage(
  value: unknown,
  options: { requireOptOut?: boolean; maxLength?: number; exactCta?: string } = {},
): string {
  const maxLength = options.maxLength ?? SMS_MESSAGE_LIMIT;
  const optOut = options.requireOptOut ? ' Reply STOP to opt out.' : '';
  let message = String(value || '').replace(/\s+/g, ' ').trim();

  if (options.requireOptOut) {
    message = message
      .replace(/\s*(?:reply\s+)?STOP\s+to\s+opt[ -]?out\.?/ig, '')
      .trim();
  }

  const cta = options.exactCta?.trim() || '';
  if (cta.length + optOut.length > maxLength) {
    throw new Error('The reviewed CTA and required opt-out exceed the SMS limit. Shorten the CTA before generating.');
  }
  if (cta) message = message.split(cta).join('').trim();
  const suffix = `${cta ? ` ${cta}` : ''}${optOut}`;
  const coreLimit = Math.max(0, maxLength - suffix.length);
  return `${trimAtWordBoundary(message, coreLimit)}${suffix}`.trim();
}
