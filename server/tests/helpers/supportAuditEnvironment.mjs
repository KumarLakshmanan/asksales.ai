import { jest } from '@jest/globals';

// Audit runs must use explicit disposable endpoints, never checked-in dotenv files.
if (process.env.SUPPORT_SYNTHETIC_AUDIT !== '1'
  || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55432'
  || process.env.DB_NAME !== 'support_ai_audit') {
  throw new Error('Support audit requires its explicitly selected loopback PostgreSQL fixture.');
}
jest.unstable_mockModule('dotenv', () => ({ default: { config: () => ({ parsed: {} }) } }));
