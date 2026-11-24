import { describe, expect, it } from '@jest/globals';
import {
  evaluateProviderVerificationChecks,
  hasConfiguredMetaAppSubscription,
  hasInstagramMessagingSubscription,
  providerVerificationRequiresReconnect,
  publicProviderEndpoints,
} from '../services/integrations/ProviderVerificationService.js';

describe('provider verification policy', () => {
  it('fails when a required provider check fails', () => {
    expect(evaluateProviderVerificationChecks([
      { id: 'identity', status: 'pass', required: true, detail: 'ok' },
      { id: 'scopes', status: 'fail', required: true, detail: 'missing' },
    ])).toEqual({ status: 'failing', errorCode: 'SCOPES' });
  });

  it('does not fail readiness for an explicitly optional diagnostic warning', () => {
    expect(evaluateProviderVerificationChecks([
      { id: 'identity', status: 'pass', required: true, detail: 'ok' },
      { id: 'webhook', status: 'fail', required: false, detail: 'missing' },
    ])).toEqual({ status: 'passing', errorCode: null });
  });

  it('does not ask owners to reconnect for deployment-level Meta readiness blocks', () => {
    expect(providerVerificationRequiresReconnect('APP_REVIEW')).toBe(false);
    expect(providerVerificationRequiresReconnect('WEBHOOK_SUBSCRIPTION')).toBe(false);
    expect(providerVerificationRequiresReconnect('PROVIDER_TOKEN')).toBe(true);
    expect(providerVerificationRequiresReconnect('REQUIRED_SCOPES')).toBe(true);
    expect(providerVerificationRequiresReconnect('MSG91_AUTH_FAILED')).toBe(true);
  });

  it('requires the configured Meta app rather than accepting any webhook subscription', () => {
    expect(hasConfiguredMetaAppSubscription([
      { id: 'other-app' },
    ], 'configured-app')).toBe(false);
    expect(hasConfiguredMetaAppSubscription([
      { id: 'configured-app' },
    ], 'configured-app')).toBe(true);
    expect(hasConfiguredMetaAppSubscription([
      { whatsapp_business_api_data: { id: 'configured-app' } },
    ], 'configured-app')).toBe(true);
  });

  it('checks Instagram Login message fields because Meta returns a subscription ID instead of the app ID', () => {
    expect(hasInstagramMessagingSubscription([{ id: 'instagram-subscription-id', subscribed_fields: ['messages', 'messaging_postbacks'] }])).toBe(true);
    expect(hasInstagramMessagingSubscription([{ id: 'instagram-subscription-id', subscribed_fields: ['messages'] }])).toBe(false);
    expect(hasInstagramMessagingSubscription([])).toBe(false);
  });

  it('builds the documented HTTPS callback endpoints from one public origin', () => {
    expect(publicProviderEndpoints('https://api.example.com/')).toEqual(expect.objectContaining({
      instagram: 'https://api.example.com/api/webhooks/instagram',
      facebook: 'https://api.example.com/api/webhooks/facebook',
      meta_ads: 'https://api.example.com/api/meta/oauth/callback',
      whatsapp: 'https://api.example.com/api/whatsapp/webhook',
      gmail: 'https://api.example.com/api/gmail/oauth/webhook',
      resend: 'https://api.example.com/api/resend/webhook',
      msg91: 'https://api.example.com/api/webhooks/sms/:userToken/delivery',
    }));
  });
});
