import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_OUTREACH_ATTACHMENT_SIZE,
  MAX_INBOUND_VIDEO_SIZE,
  getChannelAttachmentCapability,
  hasValidAttachmentSignature,
  normalizeOutreachAttachmentMime,
  safeOutreachAttachmentFileName,
  validateAttachment,
} from '../utils/outreachAttachmentPolicy.js';

describe('outreach attachment validation', () => {
  it.each([
    ['application/pdf', Buffer.from('%PDF-1.7\n')],
    ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
    ['text/plain', Buffer.from('safe plain text')],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['audio/mpeg', Buffer.from('ID3safe-mp3')],
    ['audio/ogg', Buffer.from('OggSvoice')],
    ['audio/wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEdata')])],
    ['audio/mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(4)])],
    ['audio/aac', Buffer.from([0xff, 0xf1, 0x50, 0x80])],
    ['audio/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])],
  ])('accepts a matching %s signature', (mimeType, buffer) => {
    expect(hasValidAttachmentSignature(buffer, mimeType)).toBe(true);
  });

  it('rejects MIME spoofing and binary payloads labelled as text', () => {
    expect(validateAttachment(Buffer.from('not a pdf'), 'application/pdf', 'invoice.pdf')).toEqual({
      ok: false,
      error: 'The attachment type does not match its contents.',
    });
    expect(hasValidAttachmentSignature(Buffer.from([0x41, 0x00, 0x42]), 'text/plain')).toBe(false);
  });

  it('enforces the per-file size bound before storage', () => {
    const oversized = Buffer.alloc(MAX_OUTREACH_ATTACHMENT_SIZE + 1, 0x41);
    expect(validateAttachment(oversized, 'text/plain', 'large.txt')).toEqual({
      ok: false,
      error: 'The attachment exceeds the 10 MB limit.',
    });
  });

  it('accepts bounded inbound video but keeps outbound video disabled', () => {
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(32)]);
    expect(validateAttachment(mp4, 'video/mp4', 'story.mp4', { inbound: true })).toEqual({
      ok: true,
      fileName: 'story.mp4',
      mimeType: 'video/mp4',
    });
    expect(validateAttachment(mp4, 'video/mp4', 'story.mp4')).toEqual({
      ok: false,
      error: 'Outbound video attachments are not enabled for outreach messages.',
    });
    expect(MAX_INBOUND_VIDEO_SIZE).toBe(25 * 1024 * 1024);
  });

  it('normalizes hostile filenames to a safe basename', () => {
    expect(validateAttachment(Buffer.from('hello'), 'text/plain', '../../report.txt')).toEqual({
      ok: true,
      fileName: 'report.txt',
      mimeType: 'text/plain',
    });
    expect(safeOutreachAttachmentFileName('..\\..\\secret.txt')).toBe('secret.txt');
    expect(safeOutreachAttachmentFileName(`invoice\u202Efdp.exe`)).toBe('invoicefdp.exe');
  });

  it('normalizes provider audio aliases and safely detects opaque audio responses', () => {
    expect(normalizeOutreachAttachmentMime('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(normalizeOutreachAttachmentMime('audio/mp3')).toBe('audio/mpeg');
    expect(validateAttachment(Buffer.from('OggSvoice'), 'application/octet-stream', 'voice-message')).toEqual({
      ok: true,
      fileName: 'voice-message',
      mimeType: 'audio/ogg',
    });
  });
});

describe('outreach provider attachment capabilities', () => {
  it('supports common documents over email', () => {
    expect(getChannelAttachmentCapability('email', 'application/pdf')).toEqual({ supported: true, mode: 'email' });
    expect(getChannelAttachmentCapability('gmail', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
      .toEqual({ supported: true, mode: 'email' });
  });

  it('maps WhatsApp images and documents to provider-native message types', () => {
    expect(getChannelAttachmentCapability('whatsapp', 'image/png')).toEqual({ supported: true, mode: 'whatsapp-image' });
    expect(getChannelAttachmentCapability('whatsapp', 'application/pdf')).toEqual({ supported: true, mode: 'whatsapp-document' });
    expect(getChannelAttachmentCapability('whatsapp', 'audio/ogg; codecs=opus')).toEqual({ supported: true, mode: 'whatsapp-audio' });
    expect(getChannelAttachmentCapability('whatsapp', 'image/gif').supported).toBe(false);
    expect(getChannelAttachmentCapability('whatsapp', 'image/webp').supported).toBe(false);
  });

  it('allows images and audio for official Meta messaging and rejects unsupported channels explicitly', () => {
    expect(getChannelAttachmentCapability('instagram', 'image/jpeg')).toEqual({ supported: true, mode: 'meta-image' });
    expect(getChannelAttachmentCapability('instagram', 'audio/mpeg')).toEqual({ supported: true, mode: 'meta-audio' });
    expect(getChannelAttachmentCapability('facebook', 'audio/ogg')).toEqual({ supported: true, mode: 'meta-audio' });
    expect(getChannelAttachmentCapability('instagram', 'image/webp').supported).toBe(false);
    expect(getChannelAttachmentCapability('facebook', 'application/pdf').supported).toBe(false);
    expect(getChannelAttachmentCapability('sms', 'text/plain')).toEqual({
      supported: false,
      reason: 'SMS attachments are not supported by the configured provider.',
    });
  });
});

describe('outreach attachment migration invariants', () => {
  it('enforces tenant ownership, message association, idempotency, and staged cleanup', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/155_create_outreach_message_attachments.js'),
      'utf8',
    );
    expect(migration).toContain('user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(migration).toContain('message_id INTEGER REFERENCES outreach_messages(id) ON DELETE CASCADE');
    expect(migration).toContain('outreach_message_attachments_message_file_uq');
    expect(migration).toContain('outreach_message_attachments_provider_uq');
    expect(migration).toContain('message_id IS NULL AND expires_at IS NOT NULL');
    const voiceMigration = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/161_add_outreach_voice_attachment_state.js'),
      'utf8',
    );
    expect(voiceMigration).toContain("'not_applicable'");
    expect(voiceMigration).toContain('outreach_message_attachments_tts_message_uq');
    expect(voiceMigration).toContain("source = 'tts'");
  });
});
