/** The basic email-address shape check used across the app: something@something.tld with no spaces. */
export const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the value has the basic email-address shape (EMAIL_ADDRESS_PATTERN). */
export function isEmailAddress(value: string): boolean {
  return EMAIL_ADDRESS_PATTERN.test(value);
}
