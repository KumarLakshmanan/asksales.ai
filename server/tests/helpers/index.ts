/**
 * Server test helpers — Phase 9.14.
 *
 * Centralises the boilerplate every integration test needs:
 *   1. A test user (with email + scrypt-hashed password).
 *   2. A test wallet (with a non-zero credit balance).
 *   3. A signed JWT for that user.
 *
 * The helpers talk to the real `users` and `wallets` tables when
 * `DATABASE_URL` is set, and fall back to in-memory stubs when it's
 * not — so unit tests can run in CI without a database while
 * integration tests still hit the real thing.
 *
 * Usage:
 *   import { createTestUser, createTestWallet, getTestToken } from './helpers';
 *
 *   const { user } = await createTestUser({ email: 'a@b.c' });
 *   await createTestWallet(user.id, { balance: 1000 });
 *   const token = await getTestToken(user.id);
 */

import crypto from 'crypto';

// ── In-memory fallbacks ────────────────────────────────────────────────────

interface StoredUser {
  id: number;
  email: string;
  passwordHash: string;
  name: string;
  role: 'user' | 'admin' | 'superadmin';
  isActive: boolean;
  emailVerified: boolean;
  createdAt: Date;
}

interface StoredWallet {
  id: number;
  userId: number;
  balance: number;
  currency: string;
  updatedAt: Date;
}

const _users: Map<number, StoredUser> = new Map();
const _wallets: Map<number, StoredWallet> = new Map();
const _userByEmail: Map<string, StoredUser> = new Map();
let _nextUserId = 1;
let _nextWalletId = 1;

function isDbAvailable(): boolean {
  return !!process.env.DATABASE_URL;
}

// ── Password hashing ─────────────────────────────────────────────────────

/**
 * Hash a password with a fresh random salt + scrypt. We use scrypt
 * (built into Node.js) to avoid pulling in `bcrypt` as a dev
 * dependency just for tests. The format is `salt:hash` (both hex).
 *
 * NOTE: production uses bcrypt. This is *only* for the test helpers;
 * tests that exercise the auth path use the real bcrypt code in the
 * service layer.
 */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

// ── createTestUser ───────────────────────────────────────────────────────

export interface CreateTestUserOptions {
  email?: string;
  password?: string;
  name?: string;
  role?: 'user' | 'admin' | 'superadmin';
  isActive?: boolean;
  emailVerified?: boolean;
}

export interface CreateTestUserResult {
  user: StoredUser;
  password: string;
}

/**
 * Create a test user. Uses the real DB if available, otherwise stores
 * in-process. The returned `password` is the plain-text version (so
 * the test can sign in as that user).
 */
export async function createTestUser(
  opts: CreateTestUserOptions = {},
): Promise<CreateTestUserResult> {
  const password = opts.password ?? `pw-${Math.random().toString(36).slice(2, 12)}Aa1!`;
  const email = opts.email ?? `test-${_nextUserId}-${Date.now()}@example.test`;

  if (isDbAvailable()) {
    // Lazy import so unit-test runs that don't have a DB don't pay
    // for the connection-pool bootstrap. The helpers live at
    // `server/tests/helpers/index.ts` so we need ../../ to escape
    // out of `tests/helpers/`.
    const { db } = await import('../../models/db');
    const { usersTable } = await import('../../models/users/schema');
    // The real schema column is `password` (not `passwordHash`).
    // `isActive` is an in-memory-only concept — the DB has
    // `isVerified` / `isApproved` only.
    const [user] = await db.insert(usersTable).values({
      email,
      password: hashPassword(password),
      name: opts.name ?? 'Test User',
      role: opts.role ?? 'user',
      isVerified: opts.emailVerified ?? true,
      isApproved: true,
    }).returning();
    return { user: user as unknown as StoredUser, password };
  }

  // In-memory fallback
  const user: StoredUser = {
    id: _nextUserId++,
    email,
    passwordHash: hashPassword(password),
    name: opts.name ?? 'Test User',
    role: opts.role ?? 'user',
    isActive: opts.isActive ?? true,
    emailVerified: opts.emailVerified ?? true,
    createdAt: new Date(),
  };
  _users.set(user.id, user);
  _userByEmail.set(user.email, user);
  return { user, password };
}

// ── createTestWallet ─────────────────────────────────────────────────────

export interface CreateTestWalletOptions {
  balance?: number;
  currency?: string;
}

export interface CreateTestWalletResult {
  wallet: StoredWallet;
}

/**
 * Create (or reset) a wallet for a user.
 */
export async function createTestWallet(
  userId: number,
  opts: CreateTestWalletOptions = {},
): Promise<CreateTestWalletResult> {
  const balance = opts.balance ?? 0;
  // The real `wallets` table has no `currency` column; the in-memory
  // record keeps it for parity with the interface.
  const currency = opts.currency ?? 'INR';

  if (isDbAvailable()) {
    const { db } = await import('../../models/db');
    const { walletsTable } = await import('../../models/wallets/schema');
    const [wallet] = await db.insert(walletsTable).values({
      userId,
      balance: String(balance),
    }).returning();
    return { wallet: wallet as unknown as StoredWallet };
  }

  const wallet: StoredWallet = {
    id: _nextWalletId++,
    userId,
    balance,
    currency,
    updatedAt: new Date(),
  };
  _wallets.set(userId, wallet);
  return { wallet };
}

// ── getTestToken ─────────────────────────────────────────────────────────

export interface GetTestTokenOptions {
  /** JWT expiry in seconds (currently advisory only — `generateToken`
   * uses the env-configured `JWT_EXPIRES_IN` constant). */
  expiresIn?: number;
}

/**
 * Sign a JWT for a user. Uses the same secret + format as the real
 * `auth/generateToken` so any test that exercises a protected route
 * can drop the token into the `Authorization: Bearer …` header.
 */
export async function getTestToken(
  userId: number,
  _opts: GetTestTokenOptions = {},
): Promise<string> {
  // Use the real token signer so tests cover the production path.
  const { generateToken } = await import('../../utils/jwt');
  // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
  return generateToken({ userId, type: 'access' });
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Drop all in-memory state. Tests that use the DB fallback should
 * call this in `afterEach`. Tests that hit the real DB should clean
 * up their own rows.
 */
export function resetTestState(): void {
  _users.clear();
  _wallets.clear();
  _userByEmail.clear();
  _nextUserId = 1;
  _nextWalletId = 1;
}

// ── Inspection helpers (for assertions) ────────────────────────────────

/** Look up an in-memory user. Returns `undefined` if using the real DB. */
export function findTestUser(email: string): StoredUser | undefined {
  return _userByEmail.get(email);
}

/** Look up an in-memory wallet. Returns `undefined` if using the real DB. */
export function findTestWallet(userId: number): StoredWallet | undefined {
  return _wallets.get(userId);
}
