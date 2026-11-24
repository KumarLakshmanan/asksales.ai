import { EMAIL_ADDRESS_PATTERN as EMAIL_PATTERN } from '../../shared/emailAddress.js';
const PHONE_PATTERN = /^[+0-9\s().-]+$/;

export const getMissingContactImportFields = (
  mapped: Record<string, string | null | undefined>,
) => mapped.email?.trim() || mapped.phone?.trim() ? [] : ['Email or Phone'];

export const getMissingContactImportMappings = (mapping: Record<string, string>) =>
  Object.values(mapping).some(value => value === 'email' || value === 'phone') ? [] : ['Email or Phone'];

export const validateContactImportIdentifiers = (
  email: string | null | undefined,
  phone?: string | null,
) => {
  if (!email?.trim() && !phone?.trim()) throw new Error('Email or Phone is required');
  if (email?.trim() && !EMAIL_PATTERN.test(email.trim())) {
    throw new Error('Email address is invalid');
  }

  if (!phone) return;

  const phoneDigitCount = phone.replace(/\D/g, '').length;
  if (!PHONE_PATTERN.test(phone) || phoneDigitCount < 7 || phoneDigitCount > 15) {
    throw new Error('Phone number is invalid');
  }
};

/** A shared email must not collapse two different WhatsApp recipients. */
export function contactImportIdentity(mapped: Record<string, string | null | undefined>) {
  validateContactImportIdentifiers(mapped.email, mapped.phone);
  return mapped.phone?.trim()
    ? { kind: 'phone' as const, value: mapped.phone.replace(/\D/g, '') }
    : { kind: 'email' as const, value: mapped.email!.trim().toLowerCase() };
}
