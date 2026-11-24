import { describe, expect, it } from '@jest/globals';
import {
  changePasswordSchema,
  passwordSchema,
  resetMemberPasswordSchema,
} from '../middleware/schemas';

describe('canonical password policy', () => {
  it.each([
    '',
    'short1!',
    'alllowercase1!',
    'ALLUPPERCASE1!',
    'NoNumber!',
    'NoSpecial1',
    'P@ssw0rd',
    `${'A'.repeat(126)}a1!`,
  ])('rejects an unsafe password: %s', (password) => {
    expect(passwordSchema.safeParse(password).success).toBe(false);
  });

  it('accepts a password that satisfies every policy requirement', () => {
    expect(passwordSchema.safeParse('Secure1!').success).toBe(true);
  });

  it('applies the same policy to password changes and member resets', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'existing',
      newPassword: 'weak-password',
    }).success).toBe(false);
    expect(resetMemberPasswordSchema.safeParse({
      newPassword: 'weak-password',
    }).success).toBe(false);

    expect(changePasswordSchema.safeParse({
      currentPassword: 'existing',
      newPassword: 'Secure1!',
    }).success).toBe(true);
    expect(resetMemberPasswordSchema.safeParse({
      newPassword: 'Secure1!',
    }).success).toBe(true);
  });

  it('rejects unknown fields on mutation payloads', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'existing',
      newPassword: 'Secure1!',
      adminId: 42,
    }).success).toBe(false);
  });
});
