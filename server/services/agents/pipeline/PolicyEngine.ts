import type { PipelineContext } from "./ChannelGateway.js";
import { logger } from "../../../utils/logger.js";
import { DEFAULT_BUSINESS_TIMEZONE } from "../../../utils/timezone.js";
import type { PolicyRule } from './PolicyRuleSchema.js';
import { normalizeMatchText as normalizedTopicText } from "../../../utils/matchText.js";
export type { PolicyRule } from './PolicyRuleSchema.js';

export interface PolicyViolation {
  ruleId: string;
  ruleType: string;
  message: string;
}

export interface PolicyEnforcement {
  action: 'escalate' | 'truncate' | 'append_disclaimer' | 'block' | 'auto_reply_with_hours';
  detail?: string;
}

export interface PolicyEvaluation {
  passed: boolean;
  violations: PolicyViolation[];
  enforcements: PolicyEnforcement[];
}

function minutesInTimezone(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Could not determine local time in ${timezone}.`);
  }
  return hour * 60 + minute;
}

function parseMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error(`Invalid time ${value}.`);
  return hour * 60 + minute;
}

/**
 * Operating windows are half-open: start is included and end is excluded.
 * Equal start/end represents a 24-hour window. A later start than end crosses
 * midnight in the configured IANA timezone.
 */
export function isWithinOperatingHours(now: Date, timezone: string, start: string, end: string): boolean {
  const local = minutesInTimezone(now, timezone);
  const startMinutes = parseMinutes(start);
  const endMinutes = parseMinutes(end);
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return local >= startMinutes && local < endMinutes;
  return local >= startMinutes || local < endMinutes;
}

/**
 * Matches complete words/phrases after Unicode and punctuation normalization.
 * This catches "card-number" for "card number" without matching "ass" in
 * "password" or another accidental substring.
 */
export function containsProhibitedTopic(text: string, topic: string): boolean {
  const normalizedText = ` ${normalizedTopicText(text)} `;
  const normalizedTopic = normalizedTopicText(topic);
  return normalizedTopic.length > 0 && normalizedText.includes(` ${normalizedTopic} `);
}

export class PolicyEngine {
  private evaluate(ctx: PipelineContext, rules: PolicyRule[], phase: 'before_classification' | 'after_classification' | 'all'): PolicyEvaluation {
  /**
   * Pre-generation: should the AI even attempt a reply?
   */
    const includeBefore = phase !== 'after_classification';
    const includeAfter = phase !== 'before_classification';
    const violations: PolicyViolation[] = [];
    const enforcements: PolicyEnforcement[] = [];

    const activeRules = (Array.isArray(rules) ? rules : []).filter(r => r.enabled);

    for (const rule of activeRules) {
      // 1. Channel Restriction
      if (includeBefore && rule.type === 'channel_restriction') {
        const allowedChannels = rule.config.allowedChannels || [];
        if (allowedChannels.length > 0 && !allowedChannels.includes(ctx.message.channel)) {
          violations.push({
            ruleId: rule.id,
            ruleType: rule.type,
            message: `Channel ${ctx.message.channel} is not allowed by policy.`,
          });
          enforcements.push({ action: 'block' });
        }
      }

      // 2. Auto-escalate Intent
      if (includeAfter && rule.type === 'auto_escalate_intent') {
        const prohibitedIntents = rule.config.intents || [];
        const primaryIntent = ctx.nlu?.intent;
        const matchesIntent = typeof primaryIntent === 'string' && prohibitedIntents.includes(primaryIntent);
        const matchesSecondary = (ctx.nlu?.secondaryIntents || []).some((i: string) => prohibitedIntents.includes(i));
        if (matchesIntent || matchesSecondary) {
          violations.push({
            ruleId: rule.id,
            ruleType: rule.type,
            message: `Message matched auto-escalate intent: ${ctx.nlu?.intent}.`,
          });
          enforcements.push({ action: 'escalate' });
        }
      }

      // 3. Operating Hours
      if (includeBefore && rule.type === 'operating_hours') {
        // config looks like: { timezone: 'Asia/Kolkata', start: '09:00', end: '17:00', outsideHoursAction: 'escalate' | 'auto_reply_with_hours' }
        try {
          const timezone = rule.config.timezone || DEFAULT_BUSINESS_TIMEZONE;
          const start = rule.config.start;
          const end = rule.config.end;
          const configuredNow = ctx.metadata?.policyEvaluationNow;
          const now = configuredNow instanceof Date
            ? configuredNow
            : typeof configuredNow === 'string' || typeof configuredNow === 'number'
              ? new Date(configuredNow)
              : new Date();
          if (!Number.isFinite(now.getTime())) throw new Error('Policy evaluation time is invalid.');

          if (!isWithinOperatingHours(now, timezone, start, end)) {
            violations.push({
              ruleId: rule.id,
              ruleType: rule.type,
              message: `Received outside operating hours (${start} to ${end} in ${timezone}).`,
            });
            const outsideAction = rule.config.outsideHoursAction || 'auto_reply_with_hours';
            enforcements.push({
              action: outsideAction === 'auto_reply_with_hours' ? 'auto_reply_with_hours' : 'escalate',
              detail: rule.config.customMessage || "We are currently closed.",
            });
          }
        } catch (e) {
          logger.error({ err: e, ruleId: rule.id }, '[PolicyEngine] Operating-hours policy evaluation failed');
          violations.push({
            ruleId: rule.id,
            ruleType: rule.type,
            message: 'Operating-hours policy could not be evaluated safely.',
          });
          enforcements.push({ action: 'block' });
        }
      }

      // 4. Prohibited topics must be checked before generation as well as on
      // model output. A blocked inbound topic must never enter an agent prompt.
      if (includeBefore && rule.type === 'prohibited_topics') {
        const inbound = String(ctx.message.inboundText || '').toLowerCase();
        const matched = rule.config.topics.find((topic) => containsProhibitedTopic(inbound, topic));
        if (matched) {
          violations.push({
            ruleId: rule.id,
            ruleType: rule.type,
            message: `Inbound message matched prohibited topic: "${matched}".`,
          });
          enforcements.push({ action: rule.config.action === 'escalate' ? 'escalate' : 'block' });
        }
      }

      // escalation_threshold is applied once to the composite generated-reply
      // score in ConfidenceGate, after policies, playbook and guardrails run.
    }

    const passed = violations.length === 0;
    return { passed, violations, enforcements };
  }

  /** Deterministic content/channel checks that must run before any classifier. */
  evaluateBeforeClassification(ctx: PipelineContext, rules: PolicyRule[]): PolicyEvaluation {
    return this.evaluate(ctx, rules, 'before_classification');
  }

  /** Intent policies can only be evaluated after the canonical NLU result exists. */
  evaluateAfterClassification(ctx: PipelineContext, rules: PolicyRule[]): PolicyEvaluation {
    return this.evaluate(ctx, rules, 'after_classification');
  }

  /** Backward-compatible aggregate used by policy editors and unit tests. */
  evaluatePreGeneration(ctx: PipelineContext, rules: PolicyRule[]): PolicyEvaluation {
    return this.evaluate(ctx, rules, 'all');
  }

  /**
   * Post-generation: is the reply compliant?
   */
  evaluatePostGeneration(ctx: PipelineContext, replyText: string, rules: PolicyRule[]): PolicyEvaluation {
    const violations: PolicyViolation[] = [];
    const enforcements: PolicyEnforcement[] = [];

    const activeRules = (Array.isArray(rules) ? rules : []).filter(r => r.enabled);

    for (const rule of activeRules) {
      // 1. Max Response Length
      if (rule.type === 'max_response_length') {
        const maxChars = rule.config.maxChars;
        if (replyText.length > maxChars) {
          violations.push({
            ruleId: rule.id,
            ruleType: rule.type,
            message: `Generated reply length (${replyText.length}) exceeds maximum limit (${maxChars} chars).`,
          });
          enforcements.push({
            action: rule.config.action || 'truncate',
            detail: String(maxChars),
          });
        }
      }

      // 2. Prohibited Topics
      if (rule.type === 'prohibited_topics') {
        const prohibited = rule.config.topics;
        for (const topic of prohibited) {
          if (containsProhibitedTopic(replyText, topic)) {
            violations.push({
              ruleId: rule.id,
              ruleType: rule.type,
              message: `Reply contains prohibited topic: "${topic}".`,
            });
            enforcements.push({ action: rule.config.action === 'block' ? 'block' : 'escalate' });
          }
        }
      }

      // 3. Required Disclaimer
      if (rule.type === 'required_disclaimer') {
        const disclaimer = rule.config.disclaimer || '';
        if (disclaimer && !replyText.includes(disclaimer)) {
          violations.push({
            ruleId: rule.id,
            ruleType: rule.type,
            message: `Reply lacks required policy disclaimer.`,
          });
          enforcements.push({
            action: 'append_disclaimer',
            detail: disclaimer,
          });
        }
      }
    }

    const passed = violations.length === 0;
    return { passed, violations, enforcements };
  }
}

export const policyEngine = new PolicyEngine();
