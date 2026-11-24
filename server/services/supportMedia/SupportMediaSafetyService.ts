import crypto from 'node:crypto';
import { normalizeSupportImage } from '../../utils/boundedImageNormalization.js';
import { extractAttachmentText } from '../OutreachAttachmentService.js';
import { redactPiiWithStableTokens } from '../agents/orchestration/PrivacyVaultService.js';
import { contentModerationService } from '../agents/orchestration/ContentModerationService.js';
import { logger } from '../../utils/logger.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_VISION_PROVIDER_TIMEOUT_MS = 12_000;
const SECRET_PATTERN = /(?:api[_-]?key|secret|password|passwd|bearer|private[_-]?key)\s*[:=]\s*\S+/i;
const INJECTION_PATTERN = /\b(?:ignore (?:all |the )?(?:previous|above) instructions|system prompt|developer message|reveal (?:secrets|credentials)|execute (?:this )?(?:command|tool))\b/i;

function providerFailure(error: unknown): { name: string; code?: string } {
  const value = error as { name?: unknown; code?: unknown } | null;
  return {
    name: typeof value?.name === 'string' ? value.name.slice(0, 80) : 'ProviderError',
    code: typeof value?.code === 'string' ? value.code.slice(0, 80) : undefined,
  };
}

export function validateSupportMediaMetadata(text: string): { safe: boolean; redactedText: string; reasons: string[] } {
  const privacy = redactPiiWithStableTokens(text);
  const reasons = [
    ...(privacy.tokenCount ? ['personal_data'] : []),
    ...(SECRET_PATTERN.test(text) ? ['secret_or_credential'] : []),
    ...(INJECTION_PATTERN.test(text) ? ['instruction_injection'] : []),
  ];
  return { safe: reasons.length === 0, redactedText: privacy.redactedText, reasons };
}

export interface MediaScanResult {
  status: 'published' | 'ready_for_review' | 'quarantined' | 'failed';
  normalized: Buffer;
  derivative: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  checksum: string;
  internalTags: string[];
  scanResults: Record<string, unknown>;
}

async function analyzeNormalizedImage(buffer: Buffer): Promise<{
  available: boolean; provider?: 'openai' | 'gemini' | 'openrouter'; tags: string[]; hasFace: boolean;
  likelyChild: boolean; unsafe: boolean; visibleText: string;
}> {
  if (process.env.ATTACHMENT_VISION_EXTRACTION_ENABLED !== 'true') {
    return { available: false, tags: [], hasFace: false, likelyChild: false, unsafe: false, visibleText: '' };
  }
  const { getActiveAdminCredential } = await import('../../models/adminApiCredentials/functions.js');
  const [openAiCredential, geminiCredential, openRouterCredential] = await Promise.all([
    getActiveAdminCredential('openai'),
    getActiveAdminCredential('gemini'),
    getActiveAdminCredential('openrouter'),
  ]);
  const prompt = 'Analyze this owner-uploaded business image for safe customer delivery. Return JSON only: '
    + '{"tags":string[],"hasFace":boolean,"likelyChild":boolean,"unsafe":boolean,"visibleText":string}. '
    + 'Set unsafe=true for sexual, violent, hateful, self-harm, dangerous, or otherwise customer-inappropriate imagery. '
    + 'Tags describe only directly visible non-sensitive objects. Never identify a person.';
  const parseAnalysis = (raw: string, provider: 'openai' | 'gemini' | 'openrouter') => {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.hasFace !== 'boolean' || typeof parsed.likelyChild !== 'boolean'
      || typeof parsed.unsafe !== 'boolean' || typeof parsed.visibleText !== 'string'
      || !Array.isArray(parsed.tags) || parsed.tags.some((tag) => typeof tag !== 'string')) {
      throw new Error('Media vision returned an incomplete safety decision');
    }
    return {
      available: true,
      provider,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).map((tag) => tag.slice(0, 80)).slice(0, 20) : [],
      hasFace: parsed.hasFace === true,
      likelyChild: parsed.likelyChild === true,
      unsafe: parsed.unsafe === true,
      visibleText: typeof parsed.visibleText === 'string' ? parsed.visibleText.slice(0, 4_000) : '',
    };
  };

  const openAiApiKey = openAiCredential?.apiKey || process.env.OPENAI_API_KEY;
  if (openAiApiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: openAiApiKey, timeout: MEDIA_VISION_PROVIDER_TIMEOUT_MS, maxRetries: 0 });
      const result = await openai.chat.completions.create({
        model: String(openAiCredential?.config?.model || 'gpt-4o-mini'),
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } },
        ] }],
      }, { timeout: MEDIA_VISION_PROVIDER_TIMEOUT_MS, maxRetries: 0 });
      return parseAnalysis(result.choices[0]?.message?.content || '{}', 'openai');
    } catch (error) {
      logger.warn({ provider: 'openai', ...providerFailure(error) }, '[SupportMediaSafety] Vision provider failed; trying fallback');
      // Continue to the independently governed Gemini provider.
    }
  }

  if (openRouterCredential?.apiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: openRouterCredential.apiKey, baseURL: 'https://openrouter.ai/api/v1',
        timeout: MEDIA_VISION_PROVIDER_TIMEOUT_MS, maxRetries: 0 });
      const config = openRouterCredential.config;
      const result = await client.chat.completions.create({
        model: String(config?.visionModel || config?.selectedModel || config?.model || 'openai/gpt-4o-mini'),
        temperature: 0, max_tokens: 500, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } }] }],
      }, { timeout: MEDIA_VISION_PROVIDER_TIMEOUT_MS, maxRetries: 0 });
      return parseAnalysis(result.choices[0]?.message?.content || '{}', 'openrouter');
    } catch (error) {
      logger.warn({ provider: 'openrouter', ...providerFailure(error) }, '[SupportMediaSafety] Vision provider failed; trying fallback');
    }
  }

  if (geminiCredential?.apiKey) {
    try {
      const { normalizeLLMModelName } = await import('../../utils/llmConstants.js');
      const model = normalizeLLMModelName(
        'gemini',
        String(geminiCredential.config?.model || 'gemini-3.1-flash-lite'),
      );
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiCredential.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } },
            ] }],
            generationConfig: { temperature: 0, maxOutputTokens: 500, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(MEDIA_VISION_PROVIDER_TIMEOUT_MS),
        },
      );
      const payload = await response.json().catch(() => ({})) as {
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      };
      const providerBlocked = Boolean(payload.promptFeedback?.blockReason)
        || payload.candidates?.some((candidate) => candidate.finishReason === 'SAFETY') === true;
      if (providerBlocked) {
        return { available: true, provider: 'gemini', tags: [], hasFace: false, likelyChild: false, unsafe: true, visibleText: '' };
      }
      if (!response.ok) throw new Error(`Gemini vision safety failed with HTTP ${response.status}`);
      const raw = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
      return parseAnalysis(raw, 'gemini');
    } catch (error) {
      logger.warn({ provider: 'gemini', ...providerFailure(error) }, '[SupportMediaSafety] Vision provider failed closed');
      // Fail closed below; the gallery version remains unavailable for automatic publication.
    }
  }

  return { available: false, tags: [], hasFace: false, likelyChild: false, unsafe: false, visibleText: '' };
}

export async function scanSupportMedia(input: { buffer: Buffer; mimeType: string; fileName: string }): Promise<MediaScanResult> {
  if (!ALLOWED.has(input.mimeType) || input.buffer.length === 0 || input.buffer.length > MAX_BYTES) {
    throw new Error('Only non-empty JPEG, PNG, or WebP images up to 5 MB are accepted.');
  }
  const { normalized, derivative, width, height } = await normalizeSupportImage(input.buffer);
  const derivativeMeta = { width, height };
  const analysis = await analyzeNormalizedImage(derivative);
  const fallbackOcr = analysis.available ? null : await extractAttachmentText(derivative, 'image/jpeg', input.fileName);
  const visibleText = analysis.visibleText || fallbackOcr?.text || '';
  const pii = redactPiiWithStableTokens(visibleText);
  const moderation = await contentModerationService.moderate(visibleText);
  const hasSecrets = SECRET_PATTERN.test(visibleText);
  const hasInstructionInjection = INJECTION_PATTERN.test(visibleText);
  const tagSafety = validateSupportMediaMetadata(analysis.tags.join('\n'));
  const sensitive = analysis.hasFace || analysis.likelyChild || analysis.unsafe || pii.tokenCount > 0
    || hasSecrets || hasInstructionInjection || !tagSafety.safe || moderation.flagged;
  const scannerUnavailable = !analysis.available || ['unavailable', 'disabled'].includes(moderation.source);
  return {
    status: sensitive ? 'quarantined' : scannerUnavailable ? 'ready_for_review' : 'published',
    normalized,
    derivative,
    mimeType: 'image/jpeg',
    width: derivativeMeta.width || width,
    height: derivativeMeta.height || height,
    checksum: crypto.createHash('sha256').update(normalized).digest('hex'),
    internalTags: sensitive ? [] : analysis.tags,
    scanResults: {
      signature: 'decoded_by_sharp', malware: 'sanitized_reencode', metadataStripped: true,
      visionAvailable: analysis.available, visionProvider: analysis.provider || null, moderation: moderation.source,
      hasFace: analysis.hasFace, likelyChild: analysis.likelyChild, unsafe: analysis.unsafe,
      piiTypes: pii.piiTypes, hasSecrets, hasInstructionInjection, unsafeTags: !tagSafety.safe,
      visibleTextDetected: Boolean(visibleText), scannerUnavailable,
    },
  };
}
