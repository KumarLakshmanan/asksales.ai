import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';
import {
  MAX_AUDIO_TRANSCRIPTION_SIZE,
  OUTREACH_AUDIO_MIMES,
  normalizeOutreachAttachmentMime,
} from '../utils/outreachAttachmentPolicy.js';

export const MAX_AUDIO_TRANSCRIPT_CHARS = 20_000;
export const MAX_VOICE_REPLY_CHARS = 4_000;
const AUDIO_PROVIDER_TIMEOUT_MS = 45_000;

export type AudioTranscriptionResult = {
  status: 'success' | 'empty' | 'unsupported' | 'failed';
  text?: string;
  language?: string;
  error?: string;
};

export type SpeechSynthesisResult = {
  status: 'success' | 'unsupported' | 'failed';
  buffer?: Buffer;
  mimeType?: 'audio/mpeg';
  fileName?: string;
  voice?: string;
  error?: string;
};

type OpenAIAudioConfig = {
  apiKey: string;
  transcriptionModel: string;
  speechModel: string;
  speechVoice: string;
};

async function resolveOpenAIAudioConfig(): Promise<OpenAIAudioConfig | null> {
  const credential = await getActiveAdminCredential('openai');
  if (!credential?.apiKey) return null;
  const config = credential.config || {};
  return {
    apiKey: credential.apiKey,
    transcriptionModel: String(config.audioTranscriptionModel || config.transcriptionModel || 'whisper-1'),
    speechModel: String(config.audioSpeechModel || config.speechModel || 'gpt-4o-mini-tts'),
    speechVoice: String(config.audioSpeechVoice || config.speechVoice || 'alloy'),
  };
}

export function isSupportedOutreachAudioMime(mimeType: string): boolean {
  return OUTREACH_AUDIO_MIMES.has(normalizeOutreachAttachmentMime(mimeType));
}

export async function transcribeOutreachAudio(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<AudioTranscriptionResult> {
  const normalizedMimeType = normalizeOutreachAttachmentMime(mimeType);
  if (!isSupportedOutreachAudioMime(normalizedMimeType)) {
    return { status: 'unsupported', error: `Audio transcription is not supported for ${normalizedMimeType || 'this file type'}.` };
  }
  if (!buffer.length || buffer.length > MAX_AUDIO_TRANSCRIPTION_SIZE) {
    return { status: 'failed', error: 'Audio transcription was skipped because the file is empty or exceeds the 10 MB transcription limit.' };
  }

  let provider: OpenAIAudioConfig | null;
  try {
    provider = await resolveOpenAIAudioConfig();
  } catch {
    return { status: 'failed', error: 'Audio transcription configuration could not be loaded.' };
  }
  if (!provider) {
    return { status: 'unsupported', error: 'Audio transcription is unavailable because no approved speech provider is configured.' };
  }

  try {
    const form = new FormData();
    form.set('model', provider.transcriptionModel);
    form.set('response_format', 'verbose_json');
    form.set('file', new Blob([new Uint8Array(buffer)], { type: normalizedMimeType }), fileName);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(AUDIO_PROVIDER_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({})) as {
      text?: string;
      language?: string;
      error?: { message?: string };
    };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `Audio transcription failed: ${(data.error?.message || `HTTP ${response.status}`).slice(0, 300)}`,
      };
    }
    const text = String(data.text || '')
      .replace(/\0/g, '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, MAX_AUDIO_TRANSCRIPT_CHARS);
    if (!text) return { status: 'empty', error: 'No speech could be transcribed from the audio.' };
    return {
      status: 'success',
      text,
      language: data.language ? String(data.language).slice(0, 40) : undefined,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error && error.name === 'TimeoutError'
        ? 'Audio transcription timed out.'
        : 'Audio transcription failed before any content could be approved.',
    };
  }
}

export async function synthesizeApprovedVoiceReply(text: string): Promise<SpeechSynthesisResult> {
  const boundedText = text.replace(/\0/g, '').trim().slice(0, MAX_VOICE_REPLY_CHARS);
  if (!boundedText) return { status: 'failed', error: 'The approved text reply is empty.' };
  let provider: OpenAIAudioConfig | null;
  try {
    provider = await resolveOpenAIAudioConfig();
  } catch {
    return { status: 'failed', error: 'Voice reply configuration could not be loaded.' };
  }
  if (!provider) {
    return { status: 'unsupported', error: 'Voice reply generation is unavailable because no approved speech provider is configured.' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.speechModel,
        voice: provider.speechVoice,
        input: boundedText,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(AUDIO_PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
      return {
        status: 'failed',
        error: `Voice reply generation failed: ${(data.error?.message || `HTTP ${response.status}`).slice(0, 300)}`,
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_AUDIO_TRANSCRIPTION_SIZE) {
      return { status: 'failed', error: 'The generated voice reply was empty or exceeded the 10 MB delivery limit.' };
    }
    return {
      status: 'success',
      buffer,
      mimeType: 'audio/mpeg',
      fileName: `voice-reply-${Date.now()}.mp3`,
      voice: provider.speechVoice,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error && error.name === 'TimeoutError'
        ? 'Voice reply generation timed out.'
        : 'Voice reply generation failed before delivery.',
    };
  }
}
