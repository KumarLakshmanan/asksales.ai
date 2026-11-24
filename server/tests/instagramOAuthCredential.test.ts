import {
  isOAuthBackedInstagramCredential,
  isUsableInstagramCredential,
  isUsableInstagramOAuthCredential,
} from '../utils/instagramOAuthCredential.js';

const validCredential = {
  credentialType: 'oauth',
  accessToken: 'token',
  accountIdentifier: '17841443147911746',
  tokenExpiry: new Date('2099-01-01T00:00:00.000Z'),
  sessionData: { pageId: '1042426702288900', connectedViaOAuth: true },
};

describe('Instagram OAuth credential classification', () => {
  it('accepts a normalized OAuth credential', () => {
    expect(isOAuthBackedInstagramCredential(validCredential)).toBe(true);
    expect(isUsableInstagramOAuthCredential(validCredential)).toBe(true);
    expect(isOAuthBackedInstagramCredential({ ...validCredential, accessToken: true })).toBe(true);
  });

  it('accepts a legacy manual row after a completed OAuth callback', () => {
    const legacyReconnected = { ...validCredential, credentialType: 'manual' };
    expect(isOAuthBackedInstagramCredential(legacyReconnected)).toBe(true);
    expect(isUsableInstagramOAuthCredential(legacyReconnected)).toBe(true);
  });

  it('rejects a manual credential without OAuth completion proof', () => {
    const manual = {
      ...validCredential,
      credentialType: 'manual',
      sessionData: { pageId: '1042426702288900' },
    };
    expect(isOAuthBackedInstagramCredential(manual)).toBe(false);
    expect(isUsableInstagramCredential(manual)).toBe(true);
  });

  it('accepts manual credentials without legacy token-bearing session data', () => {
    expect(isUsableInstagramCredential({
      credentialType: 'manual',
      accessToken: 'page-token',
      accountIdentifier: '17841443147911746',
      sessionData: { connectedViaManual: true },
    })).toBe(true);
  });

  it('rejects expired credentials for runtime use', () => {
    const expired = { ...validCredential, tokenExpiry: new Date('2020-01-01T00:00:00.000Z') };
    expect(isOAuthBackedInstagramCredential(expired)).toBe(true);
    expect(isUsableInstagramOAuthCredential(expired)).toBe(false);
  });

  it('accepts direct Instagram OAuth without a Facebook Page', () => {
    expect(isUsableInstagramOAuthCredential({ ...validCredential, sessionData: { useInstagramLogin: true, connectedViaOAuth: true } })).toBe(true);
  });

  it('requires the provider account, token, and linked Facebook Page', () => {
    expect(isOAuthBackedInstagramCredential({ ...validCredential, accessToken: '' })).toBe(false);
    expect(isOAuthBackedInstagramCredential({ ...validCredential, accountIdentifier: null })).toBe(false);
    expect(isOAuthBackedInstagramCredential({ ...validCredential, sessionData: { connectedViaOAuth: true } })).toBe(false);
  });
});
