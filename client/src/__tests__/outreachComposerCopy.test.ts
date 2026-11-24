import { describe, expect, it } from 'vitest';
import { channelAccountPhrase, sharedRecipientBlockReason } from '@/components/outreach/create/composerCopy';

describe('channelAccountPhrase', () => {
  it('uses the article that matches how the channel name is said', () => {
    expect(channelAccountPhrase('Email')).toBe('an Email account');
    expect(channelAccountPhrase('Instagram')).toBe('an Instagram account');
    expect(channelAccountPhrase('SMS')).toBe('an SMS account');
    expect(channelAccountPhrase('WhatsApp')).toBe('a WhatsApp account');
    expect(channelAccountPhrase('Messenger')).toBe('a Messenger account');
  });
});

describe('sharedRecipientBlockReason', () => {
  const sender = 'Choose a verified email sender in Email integrations.';
  it('returns the reason when every contact is blocked for the same reason', () => {
    expect(sharedRecipientBlockReason([{ eligible: false, reason: sender }, { eligible: false, reason: sender }])).toBe(sender);
  });
  it('keeps per-contact reasons when they differ or someone is ready', () => {
    expect(sharedRecipientBlockReason([{ eligible: false, reason: sender }, { eligible: false, reason: 'No email address' }])).toBeNull();
    expect(sharedRecipientBlockReason([{ eligible: false, reason: sender }, { eligible: true, reason: null }])).toBeNull();
  });
  it('does not collapse a single contact', () => {
    expect(sharedRecipientBlockReason([{ eligible: false, reason: sender }])).toBeNull();
  });
});
