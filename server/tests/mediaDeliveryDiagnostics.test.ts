import { describe, expect, it } from '@jest/globals';
import { mediaDeliveryDiagnostics, mediaDeliveryFailureCode } from '../services/supportMedia/MediaDeliveryDiagnostics.js';

const base = { status: 'failed', channel: 'facebook', provider_account_id: 'page', external_thread_id: 'recipient', conversation_status: 'replied' };
describe('safe media delivery diagnostics', () => {
  it.each([
    ['Invalid OAuth access token - Cannot parse access token', 'PROVIDER_AUTHORIZATION_INVALID', 'connection'],
    ['Unsupported request - method type: post', 'PROVIDER_CAPABILITY_UNAVAILABLE', 'connection'],
    ['(#100) /uploads/private.jpg should represent a valid URL', 'PROVIDER_MEDIA_FETCH_FAILED', 'retry'],
    ['(#100) Upload attachment failure.', 'PROVIDER_MEDIA_FETCH_FAILED', 'retry'],
  ])('interprets historical provider error %s without exposing it', (message, code, action) => {
    const result = mediaDeliveryDiagnostics({ ...base, failure_code: 'DELIVERY_FAILED', failure_reason: message });
    expect(result.failure_code).toBe(code);
    expect(result.recovery_action).toBe(action);
    expect(JSON.stringify(result)).not.toContain(message);
  });
  it('requires outcome verification even when a historical error resembles a rejection', () => {
    expect(mediaDeliveryDiagnostics({ ...base, status: 'uncertain', failure_reason: 'Upload failed' }))
      .toMatchObject({ recovery_action: 'verify', retry_eligible: false });
  });
  it.each([{ provider_account_id: null }, { conversation_status: 'closed' }, { external_thread_id: null }])('does not offer unsafe retries: %j', (change) => {
    expect(mediaDeliveryDiagnostics({ ...base, ...change })).toMatchObject({ retry_eligible: false, recovery_action: 'new_reply' });
  });
  it('does not leak arbitrary error details into customer-facing diagnostics', () => {
    expect(JSON.stringify(mediaDeliveryDiagnostics({ ...base, failure_reason: 'token=private-secret https://private-url' }))).not.toContain('private');
    expect(mediaDeliveryFailureCode({ code: 'META_GRAPH_200' })).toBe('PROVIDER_CAPABILITY_UNAVAILABLE');
  });
});
