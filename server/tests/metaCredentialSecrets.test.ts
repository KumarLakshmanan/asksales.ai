process.env.SECRETS_ENCRYPTION_KEY = 'meta-credential-test-key-at-least-32-characters';

import {
  decryptMetaSecret,
  encryptMetaSecret,
  isEncryptedMetaSecret,
  metaSessionMetadata,
} from '../utils/metaCredentialSecrets.js';
import { readFileSync } from 'node:fs';

describe('Meta credential secret compatibility', () => {
  it('encrypts new tokens and decrypts both marked and legacy values', () => {
    const encrypted = encryptMetaSecret('page-access-token')!;
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain('page-access-token');
    expect(isEncryptedMetaSecret(encrypted)).toBe(true);
    expect(decryptMetaSecret(encrypted)).toBe('page-access-token');
    expect(decryptMetaSecret('legacy-token')).toBe('legacy-token');
  });

  it('removes secret-bearing legacy sessionData fields while retaining readiness metadata', () => {
    expect(metaSessionMetadata({
      appSecret: 'secret',
      pageAccessToken: 'page-token',
      accessToken: 'token',
      connectedViaOAuth: true,
      selectedPageId: '123',
    })).toEqual({ connectedViaOAuth: true, selectedPageId: '123' });
  });

  it('decrypts canonical Meta tokens in webhook delivery paths', () => {
    const instagramWebhookSource = readFileSync(
      new URL('../controllers/instagramWebhookController.ts', import.meta.url),
      'utf8',
    );
    const sharedWebhookSource = readFileSync(
      new URL('../controllers/webhooks/socialReplies.ts', import.meta.url),
      'utf8',
    );

    expect(instagramWebhookSource).toContain(
      'boundMetaPageToken(accountContext!.credential)',
    );
    expect(sharedWebhookSource).toContain("resolveMetaCommentAccessToken(userId, 'instagram', providerAccountId)");
    expect(sharedWebhookSource).toContain("resolveMetaCommentAccessToken(userId, 'facebook', providerAccountId)");
    expect(sharedWebhookSource).toContain("const credentialPlatform = platform === 'instagram' ? 'instagram_api' : 'facebook_api';");
  });
});
