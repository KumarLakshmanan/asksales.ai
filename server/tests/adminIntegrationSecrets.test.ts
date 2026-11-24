import { describe, expect, it } from '@jest/globals';
import {
  maskSensitiveIntegrationConfig,
  mergeIntegrationCredentialConfig,
} from '../controllers/adminIntegrationsNewController.js';
import {
  decryptSensitiveIntegrationConfig,
  encryptSensitiveIntegrationConfig,
} from '../utils/integrationSecrets.js';
import {
  parseIntegrationCredentialInput,
  validateIntegrationRequirements,
} from '../utils/integrationCredentialValidation.js';

describe('admin integration config secret handling', () => {
  const vertexServiceAccount = JSON.stringify({
    type: 'service_account',
    project_id: 'asksales-vertex-prod',
    private_key_id: 'key-id',
    private_key: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n',
    client_email: 'asksales-runtime@asksales-vertex-prod.iam.gserviceaccount.com',
    client_id: '123456789',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
  });

  it('masks nested secret-bearing configuration without hiding operational fields', () => {
    expect(maskSensitiveIntegrationConfig({
      webhookSecret: 'whsec_real',
      pubsubTopic: 'projects/example/topics/gmail',
      serviceAccount: {
        clientEmail: 'worker@example.iam.gserviceaccount.com',
        privateKey: 'private-key',
      },
    })).toEqual({
      webhookSecret: '••••••••',
      pubsubTopic: 'projects/example/topics/gmail',
      serviceAccount: '••••••••',
    });
  });

  it('preserves omitted and masked secrets while updating ordinary fields', () => {
    expect(mergeIntegrationCredentialConfig({
      webhookSecret: 'whsec_real',
      pubsubTopic: 'projects/old/topics/gmail',
      nested: { privateKey: 'private-key', region: 'us-east-1' },
    }, {
      webhookSecret: '••••••••',
      pubsubTopic: 'projects/new/topics/gmail',
      nested: { privateKey: '••••••••', region: 'asia-south1' },
    })).toEqual({
      webhookSecret: 'whsec_real',
      pubsubTopic: 'projects/new/topics/gmail',
      nested: { privateKey: 'private-key', region: 'asia-south1' },
    });
  });

  it('supports an explicit null to remove a stored configuration field', () => {
    expect(mergeIntegrationCredentialConfig({ webhookSecret: 'whsec_real', region: 'us' }, {
      webhookSecret: null,
    })).toEqual({ region: 'us' });
  });

  it('encrypts nested config secrets at rest and restores them for server use', () => {
    const plain = {
      pubsubTopic: 'projects/example/topics/gmail',
      webhookSecret: 'webhook-secret',
      serviceAccount: { clientEmail: 'worker@example.com', privateKey: 'private-key' },
    };
    const encrypted = encryptSensitiveIntegrationConfig(plain) as Record<string, unknown>;
    expect(encrypted.webhookSecret).not.toBe(plain.webhookSecret);
    expect(JSON.stringify(encrypted)).not.toContain('private-key');
    expect(decryptSensitiveIntegrationConfig(encrypted)).toEqual(plain);
  });

  it('treats provider-specific token fields as secrets', () => {
    const plain = { developerToken: 'dev-token', bearerToken: 'bearer-token', region: 'in' };
    const encrypted = encryptSensitiveIntegrationConfig(plain) as Record<string, unknown>;
    expect(JSON.stringify(encrypted)).not.toContain('dev-token');
    expect(JSON.stringify(encrypted)).not.toContain('bearer-token');
    expect(decryptSensitiveIntegrationConfig(encrypted)).toEqual(plain);
  });

  it('strictly normalizes credential create and rotation payloads', () => {
    expect(parseIntegrationCredentialInput({
      platform: 'openai', name: ' Primary ', apiKey: ' sk-test ', priority: 'high', config: { model: 'gpt-test' },
    })).toEqual({
      platform: 'openai', name: 'Primary', apiKey: 'sk-test', priority: 'high', config: { model: 'gpt-test' },
    });
    expect(parseIntegrationCredentialInput({ apiKey: '••••••••', name: 'Rotated name' }, true))
      .toEqual({ name: 'Rotated name' });
    expect(() => parseIntegrationCredentialInput({ platform: 'openai', name: 'Key', apiKey: 'secret', extra: true }))
      .toThrow('unsupported');
    expect(() => parseIntegrationCredentialInput({ platform: 'perplexity', name: 'Retired provider', apiKey: 'secret' }))
      .toThrow('Invalid integration platform');
  });

  it('enforces provider-specific secret and configuration requirements', () => {
    expect(() => validateIntegrationRequirements({ platform: 'gmail_oauth', apiKey: '123-app.apps.googleusercontent.com' }))
      .toThrow('requires an API secret');
    expect(() => validateIntegrationRequirements({ platform: 'smtp', apiKey: 'user', apiSecret: 'password', config: {} }))
      .toThrow('SMTP requires');
    expect(() => validateIntegrationRequirements({ platform: 'custom_ai', apiKey: 'secret', config: {} }))
      .toThrow('config.baseUrl');
    expect(() => validateIntegrationRequirements({
      platform: 'vertex_ai',
      apiKey: vertexServiceAccount,
      config: { location: 'asia-south1', projectId: 'different-project' },
    })).toThrow('project_id');
    expect(() => validateIntegrationRequirements({
      platform: 'vertex_ai',
      apiKey: vertexServiceAccount,
      config: { location: 'not-a-region' },
    })).toThrow('location');
    expect(() => validateIntegrationRequirements({
      platform: 'vertex_ai',
      apiKey: vertexServiceAccount,
      config: { location: 'asia-south1', projectId: 'asksales-vertex-prod' },
    })).not.toThrow();
  });

  it('bounds structured integration configuration', () => {
    expect(() => parseIntegrationCredentialInput({ config: { port: 70000 } }, true)).toThrow('65535');
    expect(() => parseIntegrationCredentialInput({ config: { chunkSize: 99 } }, true)).toThrow('8000');
    expect(() => parseIntegrationCredentialInput({ config: { constructor: 'unsafe' } }, true)).toThrow('unsafe');
  });
});
