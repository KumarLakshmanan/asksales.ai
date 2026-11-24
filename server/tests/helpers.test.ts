import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTestUser,
  createTestWallet,
  getTestToken,
  resetTestState,
  findTestUser,
  findTestWallet,
  hashPassword,
} from './helpers';

describe('test helpers (Phase 9.14)', () => {
  beforeEach(() => {
    resetTestState();
  });

  it('createTestUser returns a user + plain password', async () => {
    const { user, password } = await createTestUser({ email: 'a@b.test' });
    expect(user.email).toBe('a@b.test');
    expect(password.length).toBeGreaterThan(0);
    expect(findTestUser('a@b.test')?.id).toBe(user.id);
  });

  it('createTestUser applies overrides', async () => {
    const { user } = await createTestUser({
      email: 'admin@b.test',
      role: 'admin',
      name: 'Custom Name',
    });
    expect(user.role).toBe('admin');
    expect(user.name).toBe('Custom Name');
  });

  it('createTestWallet stores the balance under the user id', async () => {
    const { user } = await createTestUser();
    const { wallet } = await createTestWallet(user.id, { balance: 500 });
    expect(wallet.balance).toBe(500);
    expect(findTestWallet(user.id)?.id).toBe(wallet.id);
  });

  it('getTestToken returns a non-empty JWT', async () => {
    const { user } = await createTestUser();
    const token = await getTestToken(user.id);
    expect(token.split('.').length).toBe(3); // header.payload.signature
  });

  it('hashPassword is non-deterministic (random salt)', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('resetTestState wipes in-memory state', async () => {
    const { user } = await createTestUser({ email: 'gone@x.test' });
    await createTestWallet(user.id);
    resetTestState();
    expect(findTestUser('gone@x.test')).toBeUndefined();
    expect(findTestWallet(user.id)).toBeUndefined();
  });
});
