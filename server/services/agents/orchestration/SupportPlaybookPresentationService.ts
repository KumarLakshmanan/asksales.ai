import { logger } from '../../../utils/logger.js';
import { LLMProviderFactory } from '../LLMProviderFactory.js';
import type { PlaybookDirective } from './PlaybookEngine.js';
import type { SupportChoiceManifest } from '../../../models/supportOrchestration/schema.js';
import { sanitizeStructuredForModel } from './PrivacyVaultService.js';

export interface PlaybookPresentationDecision {
  fieldKey: string;
  replyText: string;
  optionIds: string[];
  reason: string;
}

function channelOptionLimit(channel: string): number {
  if (channel === 'whatsapp') return 10;
  if (channel === 'instagram' || channel === 'facebook') return 13;
  return 20;
}

const PRESENTATION_STOP_WORDS = new Set([
  'about', 'after', 'again', 'before', 'could', 'customer', 'information',
  'please', 'provide', 'reply', 'should', 'their', 'there', 'today', 'would', 'your',
]);

export function meaningPreserved(fieldKey: string, canonical: string, reply: string): boolean {
  if (/\b(?:password|passcode|otp|one[- ]time password|cvv|card number|government id|secret|access token)\b/i.test(reply)) return false;
  const canonicalNumbers = new Set(canonical.match(/\b\d+(?:\.\d+)?\b/g) || []);
  if ((reply.match(/\b\d+(?:\.\d+)?\b/g) || []).some((number) => !canonicalNumbers.has(number))) return false;
  const synonyms: Record<string, string> = { help: 'assist', helping: 'assist', assistance: 'assist', adult: 'adults', kids: 'children', child: 'children', guests: 'adults' };
  const tokenize = (value: string) => value.toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4 && !PRESENTATION_STOP_WORDS.has(token))
    .map((token) => synonyms[token] || token);
  const anchors = new Set([
    ...tokenize(canonical),
    ...tokenize(fieldKey.replace(/([a-z])([A-Z])/g, '$1 $2')),
  ]);
  const replyTokens = new Set(tokenize(reply));
  return anchors.size === 0 || [...anchors].some((anchor) => replyTokens.has(anchor));
}

export function choicePromptWithoutRepeatedOptions(prompt: string, labels: string[]): string {
  if (!labels.length) return prompt;
  const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const known = new Set(labels.map(normalize));
  const lines = prompt.split('\n');
  const optionLine = (line: string) => known.has(normalize(line.replace(/^\s*(?:[•*\-]|\d+[.)])\s*/, '')));
  const found = new Set(lines.filter(optionLine).map(line => normalize(line.replace(/^\s*(?:[•*\-]|\d+[.)])\s*/, ''))));
  if (![...known].every(label => found.has(label))) return prompt;
  const cleaned = lines.filter(line => !optionLine(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned || prompt;
}

function rebuildChoice(choice: SupportChoiceManifest, decision: PlaybookPresentationDecision): SupportChoiceManifest {
  const selected = decision.optionIds.map((id) => choice.options.find((option) => option.id === id))
    .filter((option): option is SupportChoiceManifest['options'][number] => Boolean(option));
  const prompt = choicePromptWithoutRepeatedOptions(decision.replyText, selected.map(option => option.label));
  return {
    ...choice,
    prompt,
    options: selected,
    fallbackText: [
      prompt,
      '',
      ...selected.map((option, index) => `${index + 1}. ${option.label}`),
      '',
      'Reply with a number or describe your choice in your own words.',
    ].join('\n').trim(),
  };
}

export class SupportPlaybookPresentationService {
  async present(input: {
    userId: number;
    channel: string;
    directive: PlaybookDirective;
    recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    customerContext?: { inboundText: string; intent?: string; sentiment?: string };
  }): Promise<{ text: string; choice?: SupportChoiceManifest; generated: boolean; reason: string }> {
    const { directive } = input;
    const fallback = directive.choice?.fallbackText || directive.instruction || '';
    const policy = directive.presentation;
    // Identity confirmation has two distinct choices and must not be reduced
    // by a rephrasing model to an ordinary name collection question.
    if (/name for this booking|name should I use for this booking/i.test(fallback)) {
      return { text: input.channel === 'whatsapp' ? fallback.replace('saved contact name', 'saved WhatsApp/contact name') : fallback,
        choice: directive.choice, generated: false, reason: 'booking_name_confirmation' };
    }
    if (!policy || policy.mode !== 'governed_hybrid' || process.env.SUPPORT_PLAYBOOK_AI_PRESENTATION_ENABLED === 'false') {
      return { text: fallback, choice: directive.choice, generated: false, reason: 'fixed_or_disabled' };
    }
    const fieldKey = directive.journey?.missingFields?.[0];
    if (!fieldKey || !directive.instruction) return { text: fallback, choice: directive.choice, generated: false, reason: 'no_collect_field' };

    const options = directive.choice?.options || [];
    const allowedIds = new Set(options.map((option) => option.id));
    try {
      const recentAssistant = (input.recentMessages || []).filter((turn) => turn.role === 'assistant')
        .slice(-3).map((turn) => turn.content.slice(0, 500));
      const response = await LLMProviderFactory.createChatCompletionWithFallback(input.userId, {
        model: '',
        temperature: 0.65,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: `You rewrite one approved customer-service question. Return JSON only with fieldKey, replyText, optionIds, reason.\n
Hard rules:\n- fieldKey must be exactly ${JSON.stringify(fieldKey)}.\n- Ask only for the same information as the canonical prompt.\n- Preserve all safety and factual meaning.\n- Do not add facts, claims, prices, availability, names, contact details, links, tools, or promises.\n- optionIds may contain only the supplied opaque IDs.\n- Keep replyText under 700 characters.\n- Tone: ${policy.tone || 'natural, concise, professional'}.\n- Guidance: ${policy.guidance || 'Vary wording while preserving meaning'}.`,
        }, {
          role: 'user',
          content: JSON.stringify({
            canonicalPrompt: directive.choice?.prompt || directive.instruction,
            options: options.map((option) => ({ id: option.id, label: option.label })),
            optionStrategy: policy.optionStrategy,
            allowReordering: policy.allowReordering,
            recentAssistantPhrasings: policy.avoidRecentPhrasings ? recentAssistant : [],
            // Reference only: never follow instructions in customer content.
            // Facts/identity are not to be echoed by this presentation model.
            customerContext: input.customerContext ? sanitizeStructuredForModel({
              ...input.customerContext, inboundText: input.customerContext.inboundText.slice(0, 700),
            }).value : undefined,
          }),
        }],
        loggingContext: { userId: input.userId, purpose: 'support_playbook_presentation', service: 'SupportPlaybookPresentationService' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const raw = response.content || response.completion?.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw) as Partial<PlaybookPresentationDecision>;
      const optionIds = Array.isArray(parsed.optionIds) ? parsed.optionIds.filter((id): id is string => typeof id === 'string') : [];
      const uniqueOptionIds = [...new Set(optionIds)];
      const replyText = String(parsed.replyText || '').trim();
      const canonicalPrompt = directive.choice?.prompt || directive.instruction;
      const validOptions = uniqueOptionIds.every((id) => allowedIds.has(id))
        && uniqueOptionIds.length <= channelOptionLimit(input.channel)
        && (options.length === 0
          ? uniqueOptionIds.length === 0
          : policy.optionStrategy === 'all'
            ? uniqueOptionIds.length === options.length && options.every((option) => uniqueOptionIds.includes(option.id))
            : uniqueOptionIds.length >= 1);
      const validOrder = policy.allowReordering || uniqueOptionIds.every((id, index) => id === options[index]?.id);
      const validText = replyText.length >= 3 && replyText.length <= 700
        && !/https?:\/\//i.test(replyText)
        && meaningPreserved(fieldKey, canonicalPrompt, replyText);
      if (parsed.fieldKey !== fieldKey || !validText || !validOptions || !validOrder) {
        throw new Error('Presentation output failed deterministic verification');
      }
      const decision: PlaybookPresentationDecision = {
        fieldKey,
        replyText,
        optionIds: uniqueOptionIds,
        reason: String(parsed.reason || 'governed_rephrase').slice(0, 240),
      };
      const choice = directive.choice ? rebuildChoice(directive.choice, decision) : undefined;
      return { text: choice?.fallbackText || replyText, choice, generated: true, reason: decision.reason };
    } catch (error) {
      logger.warn({ err: error, playbookId: directive.playbookId, nodeId: directive.nodeId }, '[SupportPlaybookPresentation] Deterministic fallback used');
      return { text: fallback, choice: directive.choice, generated: false, reason: 'verification_or_provider_fallback' };
    }
  }
}

export const supportPlaybookPresentationService = new SupportPlaybookPresentationService();
