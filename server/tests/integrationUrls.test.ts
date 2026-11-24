import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  INTEGRATION_OAUTH_CALLBACK_PATHS,
  getIntegrationOAuthCallbackUrl,
} from '../utils/integrationUrls.js';

const originalEnvironment = {
  APP_URL: process.env.APP_URL,
  API_URL: process.env.API_URL,
  NGROK_URL: process.env.NGROK_URL,
};

function restore(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('integration OAuth callback URLs', () => {
  beforeEach(() => {
    delete process.env.NGROK_URL;
    delete process.env.API_URL;
    process.env.APP_URL = 'https://dev.asksales.ai/';
  });

  afterAll(() => {
    restore('APP_URL');
    restore('API_URL');
    restore('NGROK_URL');
  });

  it.each(Object.entries(INTEGRATION_OAUTH_CALLBACK_PATHS))(
    'keeps the %s callback on the configured deployment domain',
    (provider, path) => {
      expect(getIntegrationOAuthCallbackUrl(provider as keyof typeof INTEGRATION_OAUTH_CALLBACK_PATHS))
        .toBe(`https://dev.asksales.ai${path}`);
    },
  );

  it('uses the API URL when APP_URL is unavailable', () => {
    delete process.env.APP_URL;
    process.env.API_URL = 'https://api.example.test/';

    expect(getIntegrationOAuthCallbackUrl('gmail'))
      .toBe('https://api.example.test/api/gmail/oauth/callback');
  });

  it('uses an explicit tunnel URL only when configured', () => {
    process.env.NGROK_URL = 'https://oauth-tunnel.example.test/';

    expect(getIntegrationOAuthCallbackUrl('instagram'))
      .toBe('https://oauth-tunnel.example.test/api/instagram/oauth/callback');
  });
});
