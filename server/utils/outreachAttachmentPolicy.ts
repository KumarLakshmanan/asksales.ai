import path from 'node:path';

export const MAX_OUTREACH_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_INBOUND_VIDEO_SIZE = 25 * 1024 * 1024;
export const MAX_OUTREACH_ATTACHMENTS = 5;
export const MAX_AUDIO_TRANSCRIPTION_SIZE = 10 * 1024 * 1024;

export const OUTREACH_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
]);
const WHATSAPP_OUTBOUND_AUDIO_MIMES = new Set(['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac']);
const META_OUTBOUND_AUDIO_MIMES = new Set(['audio/mpeg', 'audio/ogg', 'audio/mp4']);

export const ALLOWED_OUTREACH_ATTACHMENT_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ...OUTREACH_AUDIO_MIMES,
  'video/mp4', 'video/webm', 'video/quicktime',
]);

export type ChannelAttachmentCapability = {
  supported: boolean;
  mode?: 'email' | 'whatsapp-image' | 'whatsapp-document' | 'whatsapp-audio' | 'meta-image' | 'meta-audio';
  reason?: string;
};

export function normalizeOutreachAttachmentMime(value: string): string {
  const normalized = String(value || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'audio/mp3') return 'audio/mpeg';
  if (normalized === 'audio/x-wav') return 'audio/wav';
  if (normalized === 'audio/x-m4a' || normalized === 'audio/m4a') return 'audio/mp4';
  if (normalized === 'application/ogg') return 'audio/ogg';
  return normalized;
}

export function safeOutreachAttachmentFileName(value: string): string {
  const printable = Array.from(path.basename((value || 'attachment').replace(/\\/g, '/')))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31
        && code !== 127
        && !(code >= 0x202a && code <= 0x202e)
        && !(code >= 0x2066 && code <= 0x2069);
    })
    .join('')
    .trim();
  return (printable || 'attachment').slice(0, 255);
}

export function hasValidAttachmentSignature(buffer: Buffer, mimeType: string): boolean {
  if (!buffer.length) return false;
  mimeType = normalizeOutreachAttachmentMime(mimeType);
  if (mimeType === 'text/plain' || mimeType === 'text/csv') return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/gif') return buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'application/pdf') return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/msword' || mimeType === 'application/vnd.ms-excel') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  }
  if (mimeType.includes('officedocument')) return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (mimeType === 'audio/mpeg') {
    return (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3')
      || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  }
  if (mimeType === 'audio/ogg') return buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS';
  if (mimeType === 'audio/wav') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  }
  if (mimeType === 'audio/mp4') return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'audio/aac') return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/webm') {
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (mimeType === 'video/webm') {
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

export function detectOutreachAttachmentMime(buffer: Buffer): string | null {
  const detectable = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'audio/ogg',
    'audio/wav',
    'audio/mp4',
    'audio/webm',
    'audio/aac',
    'audio/mpeg',
    'video/webm',
    'video/mp4',
    'video/quicktime',
  ];
  return detectable.find((mimeType) => hasValidAttachmentSignature(buffer, mimeType)) || null;
}

export function validateAttachment(
  buffer: Buffer,
  mimeType: string,
  originalName: string,
  options: { inbound?: boolean } = {},
): { ok: true; fileName: string; mimeType: string } | { ok: false; error: string } {
  let normalizedMimeType = normalizeOutreachAttachmentMime(mimeType);
  if (!buffer.length) return { ok: false, error: 'The attachment is empty.' };
  if (!normalizedMimeType || normalizedMimeType === 'application/octet-stream') {
    normalizedMimeType = detectOutreachAttachmentMime(buffer) || normalizedMimeType;
  }
  const isVideo = normalizedMimeType.startsWith('video/');
  const maxBytes = options.inbound && isVideo ? MAX_INBOUND_VIDEO_SIZE : MAX_OUTREACH_ATTACHMENT_SIZE;
  if (buffer.length > maxBytes) return { ok: false, error: `The attachment exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.` };
  if (!ALLOWED_OUTREACH_ATTACHMENT_MIMES.has(normalizedMimeType)) return { ok: false, error: `File type "${normalizedMimeType || mimeType}" is not allowed.` };
  if (isVideo && !options.inbound) return { ok: false, error: 'Outbound video attachments are not enabled for outreach messages.' };
  if (!hasValidAttachmentSignature(buffer, normalizedMimeType)) return { ok: false, error: 'The attachment type does not match its contents.' };
  return { ok: true, fileName: safeOutreachAttachmentFileName(originalName), mimeType: normalizedMimeType };
}

export function getChannelAttachmentCapability(channel: string, mimeType: string): ChannelAttachmentCapability {
  const normalized = channel === 'gmail' ? 'email' : channel;
  mimeType = normalizeOutreachAttachmentMime(mimeType);
  if (normalized === 'email') return { supported: true, mode: 'email' };
  if (normalized === 'whatsapp') {
    if (['image/jpeg', 'image/png'].includes(mimeType)) return { supported: true, mode: 'whatsapp-image' };
    if (WHATSAPP_OUTBOUND_AUDIO_MIMES.has(mimeType)) return { supported: true, mode: 'whatsapp-audio' };
    if ([
      'application/pdf', 'text/plain', 'text/csv', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ].includes(mimeType)) return { supported: true, mode: 'whatsapp-document' };
    return { supported: false, reason: mimeType.startsWith('audio/')
      ? 'WhatsApp does not support this audio encoding in the configured Cloud API adapter. Use MP3, M4A/MP4, AAC, or OGG/Opus.'
      : 'WhatsApp does not support this file type for document delivery.' };
  }
  if (normalized === 'facebook' || normalized === 'instagram') {
    if (META_OUTBOUND_AUDIO_MIMES.has(mimeType)) return { supported: true, mode: 'meta-audio' };
    const supportedImages = normalized === 'facebook'
      ? ['image/jpeg', 'image/png', 'image/gif']
      : ['image/jpeg', 'image/png'];
    if (supportedImages.includes(mimeType)) return { supported: true, mode: 'meta-image' };
    return { supported: false, reason: `${normalized === 'facebook' ? 'Facebook Messenger' : 'Instagram'} only supports image and audio attachments in this integration.` };
  }
  return { supported: false, reason: `${normalized.toUpperCase()} attachments are not supported by the configured provider.` };
}
