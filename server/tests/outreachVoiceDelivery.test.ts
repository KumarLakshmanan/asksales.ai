import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockDbExecute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: mockDbExecute, transaction: async (work: any) => work({ execute: mockDbExecute }) } }));
jest.unstable_mockModule('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../services/SocialMessagePersistence.js', () => ({ reconcileSocialSend: jest.fn<any>().mockResolvedValue(null) }));
const hold = jest.fn<any>().mockResolvedValue(false);
const mockClaim = jest.fn<any>();
const mockMarkSent = jest.fn<any>();
const mockMarkFailed = jest.fn<any>();
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: { holdIfDisabled: hold, claim: mockClaim, markSent: mockMarkSent, markFailed: mockMarkFailed },
}));

const mockPersistGenerated = jest.fn<any>();
const mockMarkAttachmentDelivery = jest.fn<any>();
const mockMarkProviderMediaPrepared = jest.fn<any>();
jest.unstable_mockModule('../services/OutreachAttachmentService.js', () => ({
  outreachAttachmentService: {
    persistGeneratedOutboundBuffer: mockPersistGenerated,
    markAttachmentDelivery: mockMarkAttachmentDelivery,
    markProviderMediaPrepared: mockMarkProviderMediaPrepared,
  },
}));

const mockSynthesize = jest.fn<any>();
jest.unstable_mockModule('../services/OutreachAudioService.js', () => ({
  synthesizeApprovedVoiceReply: mockSynthesize,
}));

const mockGetFileUrl = jest.fn<any>();
jest.unstable_mockModule('../services/StorageService.js', () => ({
  storageService: { getFileUrl: mockGetFileUrl },
}));

const mockUploadMedia = jest.fn<any>();
const mockSendMedia = jest.fn<any>();
const mockSendText = jest.fn<any>();
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: {
    uploadMedia: mockUploadMedia,
    sendMedia: mockSendMedia,
    sendText: mockSendText,
  },
}));

const mockInstagramSendAttachment = jest.fn<any>();
const mockFacebookSendAttachment = jest.fn<any>();
jest.unstable_mockModule('../services/instagramGraphApiService.js', () => ({
  getInstagramApiForUser: jest.fn(async () => ({ sendMessageWithAttachment: mockInstagramSendAttachment })),
}));
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({
  getFacebookApiForUser: jest.fn(async () => ({ sendMessageWithAttachment: mockFacebookSendAttachment })),
  sendFacebookDM: jest.fn(),
}));

const { OutreachVoiceReplyDeliveryService } = await import('../services/OutreachVoiceReplyDeliveryService.js');

const input = {
  userId: 9,
  conversationId: 58,
  channel: 'whatsapp' as const,
  senderIdentifier: '919987499179',
  phoneNumberId: '1095711443622725',
  rawMessageId: 'wamid.inbound-voice',
  inboundMessageId: 701,
  replyText: 'This approved response is safe to send.',
};

describe('outreach inbound voice to outbound voice delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hold.mockReset().mockResolvedValue(false);
    mockDbExecute.mockResolvedValue({ rows: [] });
    mockDbExecute.mockResolvedValueOnce({ rows: [{ id: 801 }] });
    mockClaim.mockResolvedValue({ state: 'claimed', action: { id: 44 } });
    mockMarkSent.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockMarkAttachmentDelivery.mockResolvedValue(undefined);
    mockMarkProviderMediaPrepared.mockResolvedValue(undefined);
    mockSynthesize.mockResolvedValue({
      status: 'success',
      buffer: Buffer.from('ID3generated'),
      mimeType: 'audio/mpeg',
      fileName: 'voice-reply.mp3',
      voice: 'alloy',
    });
    mockPersistGenerated.mockResolvedValue({ id: 'attachment-uuid', fileId: 91 });
    mockUploadMedia.mockResolvedValue({ id: 'wa-media-1' });
    mockSendMedia.mockResolvedValue({ messages: [{ id: 'wamid.voice-reply' }] });
    mockSendText.mockResolvedValue({ messages: [{ id: 'wamid.text-fallback' }] });
    mockGetFileUrl.mockResolvedValue('https://private-storage.test/signed-voice.mp3');
    mockInstagramSendAttachment.mockResolvedValue({ success: true, messageId: 'ig.voice-reply' });
    mockFacebookSendAttachment.mockResolvedValue({ success: true, messageId: 'fb.voice-reply' });
  });

  it('stores the generated audio on the exact outbound message and sends one native audio message', async () => {
    const service = new OutreachVoiceReplyDeliveryService();
    const result = await service.deliver(input);

    expect(mockPersistGenerated).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9,
      messageId: 801,
      sourceKey: 'tts:44',
      mimeType: 'audio/mpeg',
    }));
    expect(mockSendMedia).toHaveBeenCalledTimes(1);
    expect(mockSendMedia).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'audio',
      mediaId: 'wa-media-1',
    }));
    expect(mockMarkProviderMediaPrepared).toHaveBeenCalledWith({
      publicId: 'attachment-uuid',
      messageId: 801,
      userId: 9,
      providerMediaId: 'wa-media-1',
    });
    expect(mockMarkAttachmentDelivery).toHaveBeenCalledWith(expect.objectContaining({
      publicId: 'attachment-uuid',
      messageId: 801,
      status: 'sent',
      providerAttachmentId: 'wamid.voice-reply',
      providerMediaId: 'wa-media-1',
    }));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockMarkSent).toHaveBeenCalledWith(44, 'wamid.voice-reply');
    expect(result).toMatchObject({ sentAsVoice: true, externalMessageId: 'wamid.voice-reply' });
  });

  it('falls back visibly to text when TTS is unavailable before provider delivery', async () => {
    mockSynthesize.mockResolvedValue({
      status: 'unsupported',
      error: 'Voice reply generation is unavailable because no approved speech provider is configured.',
    });
    const service = new OutreachVoiceReplyDeliveryService();
    const result = await service.deliver(input);

    expect(mockSendMedia).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).toHaveBeenCalledWith(44, 'wamid.text-fallback');
    expect(result).toMatchObject({
      sentAsVoice: false,
      externalMessageId: 'wamid.text-fallback',
      fallbackReason: 'Voice reply generation is unavailable because no approved speech provider is configured.',
    });
  });

  it.each([
    ['instagram', 'ig.voice-reply'],
    ['facebook', 'fb.voice-reply'],
  ] as const)('delivers approved voice through the official %s audio adapter', async (channel, providerMessageId) => {
    const service = new OutreachVoiceReplyDeliveryService();
    const result = await service.deliver({
      ...input,
      channel,
      senderIdentifier: `${channel}-recipient`,
      phoneNumberId: undefined,
    });

    const sendMock = channel === 'instagram' ? mockInstagramSendAttachment : mockFacebookSendAttachment;
    expect(sendMock).toHaveBeenCalledWith(
      `${channel}-recipient`,
      'audio',
      'https://private-storage.test/signed-voice.mp3',
    );
    expect(mockMarkAttachmentDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
      providerAttachmentId: providerMessageId,
    }));
    expect(result).toMatchObject({ sentAsVoice: true, externalMessageId: providerMessageId });
  });

  it('does not repeat TTS or provider delivery for an already-sent decision', async () => {
    mockClaim.mockResolvedValue({ state: 'already_sent', action: { id: 44, providerMessageId: 'wamid.existing' } });
    mockDbExecute.mockReset();
    mockDbExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 801, message_type: 'audio' }] })
      .mockResolvedValue({ rows: [] });
    const service = new OutreachVoiceReplyDeliveryService();
    const result = await service.deliver(input);

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockSendMedia).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sentAsVoice: true, externalMessageId: 'wamid.existing' });
  });

  it('suppresses text fallback when the voice send outcome is uncertain', async () => {
    mockSendMedia.mockRejectedValue(Object.assign(new Error('network reset'), { deliveryAttempted: true }));
    const service = new OutreachVoiceReplyDeliveryService();

    await expect(service.deliver(input)).rejects.toThrow('Voice delivery outcome is uncertain');
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith(44, 'network reset', true);
    expect(mockMarkAttachmentDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('uncertain'),
    }));
  });

  it('safely falls back to text after a confirmed provider rejection', async () => {
    mockSendMedia.mockRejectedValue(Object.assign(new Error('unsupported codec'), {
      deliveryAttempted: true,
      outcomeUncertain: false,
    }));
    const service = new OutreachVoiceReplyDeliveryService();

    const result = await service.deliver(input);

    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sentAsVoice: false,
      externalMessageId: 'wamid.text-fallback',
      fallbackReason: 'WhatsApp rejected the voice reply: unsupported codec',
    });
  });
});

it('keeps the text fallback drafted when automation is disabled during synthesis', async () => {
  jest.clearAllMocks();
  mockClaim.mockResolvedValue({ state: 'claimed', action: { id: 44 } });
  mockDbExecute.mockResolvedValueOnce({ rows: [{ id: 801 }] });
  hold.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
  mockSynthesize.mockResolvedValue({ status: 'unsupported' });
  expect(await new OutreachVoiceReplyDeliveryService().deliver(input)).toMatchObject({ drafted: true, externalMessageId: null });
  expect(mockSendText).not.toHaveBeenCalled(); expect(mockSendMedia).not.toHaveBeenCalled();
});
