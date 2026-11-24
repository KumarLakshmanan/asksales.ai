import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetActiveAdminCredential = jest.fn<any>();
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential: mockGetActiveAdminCredential,
}));

const {
  MAX_AUDIO_TRANSCRIPT_CHARS,
  synthesizeApprovedVoiceReply,
  transcribeOutreachAudio,
} = await import('../services/OutreachAudioService.js');

describe('outreach audio transcription and speech synthesis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveAdminCredential.mockResolvedValue({
      apiKey: 'test-key',
      config: {
        audioTranscriptionModel: 'whisper-test',
        audioSpeechModel: 'tts-test',
        audioSpeechVoice: 'alloy',
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('transcribes bounded audio and preserves detected language as grounded metadata', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      text: `hello from the recording ${'x'.repeat(MAX_AUDIO_TRANSCRIPT_CHARS)}`,
      language: 'en',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await transcribeOutreachAudio(Buffer.from('ID3voice'), 'audio/mp3', 'voice.mp3');

    expect(result.status).toBe('success');
    expect(result.text?.length).toBe(MAX_AUDIO_TRANSCRIPT_CHARS);
    expect(result.language).toBe('en');
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((request[1]?.body as FormData).get('model')).toBe('whisper-test');
  });

  it('does not invent a transcript when credentials are unavailable', async () => {
    mockGetActiveAdminCredential.mockResolvedValue(null);
    const fetchMock = jest.spyOn(global, 'fetch');
    const result = await transcribeOutreachAudio(Buffer.from('OggSvoice'), 'audio/ogg', 'voice.ogg');
    expect(result).toEqual({
      status: 'unsupported',
      error: 'Audio transcription is unavailable because no approved speech provider is configured.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('converts only the bounded approved reply text to MP3', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(Buffer.from('ID3generated-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    }));

    const result = await synthesizeApprovedVoiceReply(`Approved reply ${'a'.repeat(5_000)}`);

    expect(result).toMatchObject({ status: 'success', mimeType: 'audio/mpeg', voice: 'alloy' });
    expect(result.buffer?.subarray(0, 3).toString()).toBe('ID3');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('tts-test');
    expect(body.input.length).toBe(4_000);
  });

  it('returns an actionable failure without claiming speech generation', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'model unavailable' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    const result = await synthesizeApprovedVoiceReply('Approved reply');
    expect(result).toEqual({
      status: 'failed',
      error: 'Voice reply generation failed: model unavailable',
    });
  });
});
