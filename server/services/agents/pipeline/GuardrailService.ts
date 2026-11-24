import type { PipelineContext } from "./ChannelGateway.js";
import { privacyVaultService, redactCredentialEchoes } from '../orchestration/PrivacyVaultService.js';
import { policyEngine } from "./PolicyEngine.js";
import { contentModerationService } from "../orchestration/ContentModerationService.js";
import { policyRulesFromConfig } from './PolicyRuleSchema.js';
import { fitPublishedQuote, splitPublishedQuote } from '../../knowledge/KnowledgeQuoteFormatting.js';
import { redactWithVerifiedBusinessContacts } from '../../knowledge/KnowledgeBusinessContacts.js';

export interface GuardrailMod {
  type: 'pii_redacted' | 'placeholder_stripped' | 'length_truncated'
      | 'disclaimer_appended' | 'toxicity_blocked' | 'prompt_injection_blocked';
  detail: string;
}

export interface GuardrailResult {
  safe: boolean;
  action: GuardrailAction;
  violations: string[];
  modifications: GuardrailMod[];
  finalText: string;
}

export type GuardrailAction = 'allow' | 'sanitize' | 'refuse' | 'human_handoff' | 'emergency_escalation';

export interface InboundGuardrailResult {
  safe: boolean;
  action: GuardrailAction;
  reason?: string;
  categories?: string[];
  source?: string;
  providerAttempts?: Array<{ provider: string; model: string; status: string; failureClass?: string }>;
}

// Simple prompt injection detection
const PROMPT_INJECTION_RE = /ignore (?:all |any )?(?:previous|prior|above) instructions|reveal (?:the )?(?:system|developer) prompt|system prompt|developer message|you are now (?:a|an)|jailbreak|act as if you have no rules|override (?:your|the) safety/i;
// Very simple bad words list for toxicity block
const TOXICITY_RE = /\b(?:fuck|shit|bitch|asshole|bastard)\b/i;
const OUTAGE_SAFE_GREETING_RE = /^\s*(?:hi+|hello+|hey+|good\s+(?:morning|afternoon|evening)|namaste|thanks?|thank\s+you|ok(?:ay)?|yes|no)\s*[!.?]*\s*$/i;
const OUTAGE_SAFE_SELECTION_RE = /^\s*(?:[1-9]|1[0-3])(?:\s*[.)-])?\s*$/;
const OUTAGE_SAFE_CATALOG_RE = /\b(?:rooms?|villas?|amenit(?:y|ies)|facilit(?:y|ies)|menu|brochures?|photos?|images?|gallery|resort|property|restaurant|spa|activities|club\s+room|pool\s+villa|sanctuary\s+villa)\b/i;
const OUTAGE_SENSITIVE_RE = /\b(?:book(?:ing)?|availability|available|price|rate|payment|pay|refund|cancel|account|password|otp|login|card|bank|medical|legal|emergency|danger|hurt|kill|suicide|weapon|minor|child|private|secret)\b/i;

export function isDeterministicLowRiskModerationFallback(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized || normalized.length > 300) return false;
  if (OUTAGE_SAFE_GREETING_RE.test(normalized) || OUTAGE_SAFE_SELECTION_RE.test(normalized)) return true;
  return OUTAGE_SAFE_CATALOG_RE.test(normalized) && !OUTAGE_SENSITIVE_RE.test(normalized);
}

export class GuardrailService {
  /**
   * Run inbound checks (input safety).
   */
  async checkInbound(text: string): Promise<InboundGuardrailResult> {
    if (!text) return { safe: true, action: 'allow' };

    if (PROMPT_INJECTION_RE.test(text)) {
      return { safe: false, action: 'human_handoff', reason: 'Detected potential prompt injection attempt.' };
    }

    if (TOXICITY_RE.test(text)) {
      // Upset customers may use profanity. Treat it as untrusted language, not
      // as proof that the support request itself is unsafe.
      return { safe: true, action: 'sanitize', reason: 'Customer message contains abusive language.', categories: ['abusive_language'], source: 'deterministic' };
    }

    const moderation = await contentModerationService.moderate(text);
    if (moderation.status === 'unavailable' && isDeterministicLowRiskModerationFallback(text)) {
      return {
        safe: true,
        action: 'allow',
        reason: 'Approved deterministic low-risk fallback used while moderation providers were unavailable.',
        categories: ['moderation_unavailable_low_risk_fallback'],
        source: 'deterministic',
        providerAttempts: moderation.providerAttempts,
      };
    }
    if (moderation.status === 'unavailable') {
      return {
        safe: false,
        action: 'human_handoff',
        reason: 'Safety review is temporarily unavailable; this request requires human review.',
        categories: ['moderation_unavailable'],
        source: moderation.source,
        providerAttempts: moderation.providerAttempts,
      };
    }
    if (moderation.flagged) {
      return {
        safe: false,
        action: moderation.categories.some((category) => ['self_harm_intent', 'credible_violence'].includes(category))
          ? 'emergency_escalation'
          : 'human_handoff',
        reason: `Content moderation requires human review (${moderation.categories.join(', ') || 'flagged'}).`,
        categories: moderation.categories,
        source: moderation.source,
        providerAttempts: moderation.providerAttempts,
      };
    }

    return { safe: true, action: 'allow', categories: moderation.categories, source: moderation.source, providerAttempts: moderation.providerAttempts };
  }

  /**
   * Run outbound checks (output safety, policy compliance, PII redaction).
   */
  async checkOutbound(replyText: string, ctx: PipelineContext): Promise<GuardrailResult> {
    let finalText = replyText || '';
    const violations: string[] = [];
    const modifications: GuardrailMod[] = [];
    let credentialSource = ctx.message?.inboundText || '';
    const privacy = ctx.metadata?.privacy;
    const hasProtectedCredentials = (Array.isArray(privacy?.piiTypes)
      && privacy.piiTypes.some((type: unknown) => type === 'credential' || type === 'otp'))
      || /\[(?:credential|otp)_\d+\]/i.test(credentialSource);
    if (hasProtectedCredentials) {
      const vaultId = Number(privacy?.vaultId || 0);
      try {
        const record = Number.isSafeInteger(vaultId) && vaultId > 0
          ? await privacyVaultService.reveal(ctx.message.userId, vaultId, {
            conversationId: ctx.message.conversationId,
            actor: 'system:outbound-guardrail', purpose: 'credential_echo_prevention',
            ...(ctx.message.messageId && ctx.message.metadata?.conversationKind !== 'support_widget'
              ? { messageId: ctx.message.messageId } : {}),
          }) : null;
        if (!record || redactCredentialEchoes(record.rawText, record.rawText) === record.rawText) throw new Error('Credential echo protection evidence unavailable');
        // Server-only equality protection. Never attach this raw source to the
        // context, model inputs, violations, or logging metadata.
        credentialSource = record.rawText;
      } catch {
        return {
          safe: false, action: 'human_handoff', violations: ['Sensitive credential output protection is unavailable.'],
          modifications: [], finalText: 'For your security, please do not share passwords or one-time codes. A support team member can help you safely.',
        };
      }
    }

    // 1. Toxicity check on outbound
    if (TOXICITY_RE.test(finalText)) {
      violations.push('Outbound response contained prohibited toxic/offensive language.');
      modifications.push({ type: 'toxicity_blocked', detail: 'Profanity detected in AI draft' });
      // Redact the bad word or make it safe
      finalText = "I apologize, but I cannot fulfill that request.";
      return { safe: false, action: 'refuse', violations, modifications, finalText };
    }

    // 2. Remove only known unresolved placeholders. Arbitrary bracketed text
    // may be a citation, stable privacy token, or legitimate product syntax.
    const cleaned = finalText
      .replace(/\s*\[(?:your\s+)?(?:name|company|email|phone|meeting\s+link|booking\s+link|payment\s+link|insert[^\]]*)\]\s*/gi, ' ')
      // Stable privacy tokens are valid only inside the protected model lane.
      // If one survives into a draft, it is orphaned context (commonly from a
      // redacted KB example) and must never become customer-facing text.
      .replace(/\s*\[(?:(?:name|company|email|phone|address|ssn|payment_card|ip_address|government_id|credential|otp)_\d+|redacted_secret|truncated_structured_context)\]\s*/gi, ' ')
      .replace(/\s*\{(?:name|company|email|phone|link)\}\s*/gi, ' ')
      // Normalize horizontal whitespace only. Newlines are semantic channel
      // structure: collapsing them breaks numbered lists and merges the first
      // option into the preceding question on WhatsApp, Meta DMs, and email.
      .replace(/[\t ]{2,}/g, ' ')
      .replace(/[\t ]+\n/g, '\n')
      .replace(/\n[\t ]+/g, '\n')
      .trim();

    if (cleaned !== finalText) {
      modifications.push({
        type: 'placeholder_stripped',
        detail: 'Hallucinated placeholder brackets removed',
      });
      finalText = cleaned;
    }

    // 3. Redact customer PII while preserving explicitly configured business
    // contact values (for example the hotel's public reservations number).
    const allowlist = Array.isArray(ctx.metadata?.businessPiiAllowlist)
      ? ctx.metadata.businessPiiAllowlist.filter((item: unknown): item is string => typeof item === 'string' && item.length > 2)
      : [];
    // Credential echoes are never exempted by the public-business allowlist.
    const protectedText = redactCredentialEchoes(finalText, credentialSource);
    const redacted = redactWithVerifiedBusinessContacts(protectedText, allowlist);
    if (redacted !== finalText) {
      modifications.push({
        type: 'pii_redacted',
        detail: 'PII redacted from outbound AI reply',
      });
      finalText = redacted;
    }

    // 4. Run PolicyEngine post-generation check
    const rules = policyRulesFromConfig(ctx.metadata?.agentConfig?.escalationRules || []);
    const policyEval = policyEngine.evaluatePostGeneration(ctx, finalText, rules);

    if (!policyEval.passed) {
      const disclaimers = policyEval.enforcements
        .filter((enforcement) => enforcement.action === 'append_disclaimer' && enforcement.detail)
        .map((enforcement) => enforcement.detail as string)
        .filter((disclaimer, index, all) => all.indexOf(disclaimer) === index);
      for (const disclaimer of disclaimers) {
        if (!finalText.includes(disclaimer)) {
          finalText = `${finalText}\n\n${disclaimer}`;
          modifications.push({ type: 'disclaimer_appended', detail: 'Appended required disclaimer' });
        }
      }

      const truncationLimits = policyEval.enforcements
        .filter((enforcement) => enforcement.action === 'truncate' && enforcement.detail)
        .map((enforcement) => Number(enforcement.detail))
        .filter((limit) => Number.isInteger(limit) && limit > 0);
      if (truncationLimits.length) {
        const maxChars = Math.min(...truncationLimits);
        if (finalText.length > maxChars) {
          if (ctx.agentResult?.answerVerification?.reason === 'verified_natural_knowledge_answer') {
            // Cutting a verified sentence can remove an exclusion/qualification
            // and invalidate its review. Never deliver a sliced paraphrase.
            violations.push('Complete verified reply cannot fit the configured response limit.');
          } else if (ctx.agentResult?.answerVerification?.reason === 'verbatim_published_evidence') {
            const internalPreview = ['advisory', 'preview'].includes(ctx.message.metadata?.executionMode || '')
              && ctx.message.metadata?.conversationKind === 'owner_support';
            const complete = internalPreview
              ? splitPublishedQuote(finalText, ctx.agentResult.answerVerification, maxChars) : null;
            const fitted = internalPreview ? null : fitPublishedQuote(finalText, ctx.agentResult.answerVerification, maxChars);
            if (complete) {
              finalText = complete;
              modifications.push({ type: 'length_truncated', detail: 'Split complete published information into bounded internal-preview messages without dropping options or terms.' });
            } else if (fitted) {
              finalText = fitted.text;
              ctx.agentResult.answerVerification = fitted.verification;
              ctx.agentResult.claimEvidence = fitted.verification.claims;
              modifications.push({ type: 'length_truncated', detail: 'Kept complete published excerpts, source terms, and required suffix within the response limit.' });
            } else {
              violations.push('Complete published information and its terms cannot fit the configured response limit.');
            }
          } else {
          const requiredSuffix = disclaimers.length ? `\n\n${disclaimers.join('\n\n')}` : '';
          if (requiredSuffix.length > maxChars) {
            violations.push('Required policy disclaimer exceeds the maximum response length.');
          } else {
            const bodyBudget = maxChars - requiredSuffix.length;
            const body = requiredSuffix && finalText.endsWith(requiredSuffix)
              ? finalText.slice(0, -requiredSuffix.length)
              : finalText;
            finalText = `${body.slice(0, bodyBudget)}${requiredSuffix}`;
            modifications.push({ type: 'length_truncated', detail: `Truncated to at most ${maxChars} chars` });
          }
          }
        }
      }

      for (const enforcement of policyEval.enforcements) {
        if (enforcement.action === 'escalate') {
          // Escalation doesn't change final text, it just signals unsafe/handoff needed
          violations.push('Policy requested human escalation.');
        }
        if (enforcement.action === 'block') {
          violations.push('Policy blocked the generated response.');
        }
      }
    }

    // Policies can append text after the main PII pass. Apply secret protection
    // again so no later suffix can reintroduce a disclosed credential.
    const secretSafeText = redactCredentialEchoes(redactCredentialEchoes(finalText, finalText), credentialSource)
      .replace(/\[(?:credential|otp)_\d+\]/gi, '[REDACTED_SECRET]');
    if (secretSafeText !== finalText) {
      finalText = secretSafeText;
      if (!modifications.some(mod => mod.type === 'pii_redacted')) modifications.push({ type: 'pii_redacted', detail: 'Sensitive credentials redacted from outbound reply' });
    }
    const safe = violations.length === 0;
    return { safe, action: safe ? (modifications.length ? 'sanitize' : 'allow') : 'human_handoff', violations, modifications, finalText };
  }
}

export const guardrailService = new GuardrailService();
