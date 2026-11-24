import { passwordFitsBcrypt } from '../../../shared/passwords';

export const PASSWORD_POLICY_MESSAGE =
  "Use 8–72 characters with uppercase, lowercase, number, and special character. The limit is 72 UTF-8 bytes; some characters use more than one byte.";

export function getPasswordChecks(password: string) {
  return {
    length: password.length >= 8 && passwordFitsBcrypt(password),
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
}

export function isStrongPassword(password: string): boolean {
  return Object.values(getPasswordChecks(password)).every(Boolean);
}
