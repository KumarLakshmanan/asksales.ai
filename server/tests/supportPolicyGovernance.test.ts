import { readFileSync } from 'node:fs';
import { describe, expect, it, jest } from '@jest/globals';
import {
  containsProhibitedTopic,
  isWithinOperatingHours,
} from '../services/agents/pipeline/PolicyEngine.js';
import {
  SUPPORT_POLICY_CHANNELS,
  validatePolicyRules,
} from '../services/agents/pipeline/PolicyRuleSchema.js';
import { guardrailService } from '../services/agents/pipeline/GuardrailService.js';
import { GuardrailComplianceStage } from '../services/agents/pipeline/stages/GuardrailComplianceStage.js';
import {
  agentSupportsChannel,
  assignmentAgentAvailabilityError,
} from '../services/agents/pipeline/stages/AgentConfigurationStage.js';
import { configuredRate } from '../services/agents/pipeline/stages/RateLimitStage.js';
import {
  isRepeatedPlaybookEvent,
  validatePlaybookGraph,
} from '../services/agents/orchestration/PlaybookEngine.js';
import { decideToolRecovery } from '../services/agents/orchestration/SafeToolExecutor.js';
import { INTERNAL_SUPPORT_ASSIST_SCOPE } from '../services/agents/pipeline/InternalSupportAssistScope.js';
import { validateSupportAgentMetadata } from '../services/agents/orchestration/SupportAgentConfigurationSchema.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as governanceMigration } from '../migrations/152_harden_support_ai_policy_governance.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as singleActiveMigration } from '../migrations/187_enforce_single_active_support_agent.js';

function context(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      userId: 1,
      conversationId: 2,
      channel: 'web',
      senderIdentifier: 'visitor',
      inboundText: 'hello',
    },
    policyViolations: [],
    confidence: 1,
    metadata: {},
    ...overrides,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('Support AI policy governance', () => {
  it('accepts only the versioned support-agent metadata schema', () => {
    expect(validateSupportAgentMetadata({
      configurationSchemaVersion: 1,
      privacyStatus: 'enforced',
      toolApprovalStatus: 'required',
      autoApproveTools: ['answer_from_knowledge_base'],
    })).toEqual([]);
    expect(validateSupportAgentMetadata({ configurationSchemaVersion: 2 })).not.toEqual([]);
    expect(validateSupportAgentMetadata({ unknownRuntimeSwitch: true })).not.toEqual([]);
  });

  it('strictly rejects malformed and legacy policy rule shapes', () => {
    expect(validatePolicyRules([{
      id: 'rate',
      type: 'rate_limit',
      enabled: true,
      config: { maxMessages: 10, windowMinutes: 60 },
    }])).not.toEqual([]);
    expect(validatePolicyRules([{
      id: 'hours',
      type: 'operating_hours',
      enabled: true,
      config: {
        timezone: 'Not/AZone',
        start: '9am',
        end: '17:00',
        outsideHoursAction: 'send_anyway',
      },
    }])).not.toEqual([]);
    expect(validatePolicyRules([{
      id: 'valid-rate',
      type: 'rate_limit',
      enabled: true,
      config: { limit: 15, windowSeconds: 3600, action: 'escalate' },
    }])).toEqual([]);
    expect(validatePolicyRules([
      {
        id: 'duplicate',
        type: 'rate_limit',
        enabled: true,
        config: { limit: 15, windowSeconds: 3600, action: 'escalate' },
      },
      {
        id: 'duplicate',
        type: 'required_disclaimer',
        enabled: true,
        config: { disclaimer: 'Terms apply.' },
      },
    ])).toEqual(expect.arrayContaining([expect.stringContaining('Duplicate policy rule ID')]));
  });

  it('evaluates ordinary and overnight windows in the configured timezone', () => {
    expect(isWithinOperatingHours(
      new Date('2026-07-27T18:45:00.000Z'),
      'Asia/Kolkata',
      '22:00',
      '06:00',
    )).toBe(true);
    expect(isWithinOperatingHours(
      new Date('2026-07-27T12:00:00.000Z'),
      'Asia/Kolkata',
      '22:00',
      '06:00',
    )).toBe(false);
    expect(isWithinOperatingHours(
      new Date('2026-07-27T16:30:00.000Z'),
      'America/Los_Angeles',
      '09:00',
      '17:00',
    )).toBe(true);
  });

  it('matches normalized topic phrases without substring false positives', () => {
    expect(containsProhibitedTopic('Never share your card-number here.', 'card number')).toBe(true);
    expect(containsProhibitedTopic('Please reset my password.', 'ass')).toBe(false);
    expect(containsProhibitedTopic('The classic plan is fine.', 'class')).toBe(false);
  });

  it('enforces the response limit exactly, including an appended disclaimer', async () => {
    const result = await guardrailService.checkOutbound('abcdefghijklmno', context({
      metadata: {
        agentConfig: {
          escalationRules: [
            {
              id: 'disclaimer',
              type: 'required_disclaimer',
              enabled: true,
              config: { disclaimer: 'D' },
            },
            {
              id: 'length',
              type: 'max_response_length',
              enabled: true,
              config: { maxChars: 10, action: 'truncate' },
            },
          ],
        },
      },
    }));
    expect(result.finalText).toHaveLength(10);
    expect(result.finalText.endsWith('\n\nD')).toBe(true);
  });

  it('fails closed when outbound guardrail execution throws', async () => {
    const original = guardrailService.checkOutbound;
    guardrailService.checkOutbound = jest.fn(async () => {
      throw new Error('guardrail unavailable');
    });
    try {
      await expect(new GuardrailComplianceStage().execute(context({
        agentResult: { replyText: 'draft', confidence: 1 },
      }))).rejects.toMatchObject({ outcome: 'human_handoff' });
    } finally {
      guardrailService.checkOutbound = original;
    }
  });

  it('uses one fixed-window rate rule and preserves wrapper metadata', () => {
    expect(configuredRate(context({
      metadata: {
        agentConfig: {
          escalationRules: {
            reviewMode: 'strict',
            rules: [{
              id: 'rate',
              type: 'rate_limit',
              enabled: true,
              config: { limit: 7, windowSeconds: 120, action: 'block' },
            }],
          },
        },
      },
    }))).toEqual({ limit: 7, windowSeconds: 120, action: 'block' });
  });
});

describe('Support AI routing, lifecycle, retry, and scope contracts', () => {
  it('keeps public-comment identity while allowing an explicitly scoped parent channel', () => {
    expect(SUPPORT_POLICY_CHANNELS).toEqual(expect.arrayContaining(['instagram_comment', 'facebook_comment']));
    expect(agentSupportsChannel(['instagram'], 'instagram_comment')).toBe(true);
    expect(agentSupportsChannel(['facebook_comment'], 'facebook_comment')).toBe(true);
    expect(agentSupportsChannel(['web'], 'instagram_comment')).toBe(false);
  });

  it('requires a real enabled assignment agent in the selected channel', () => {
    expect(assignmentAgentAvailabilityError(null, 'web')).toContain('exist and be enabled');
    expect(assignmentAgentAvailabilityError({ enabled: false, channelScope: [] }, 'web')).toContain('enabled');
    expect(assignmentAgentAvailabilityError({ enabled: true, channelScope: ['email'] }, 'instagram')).toContain('instagram');
    expect(assignmentAgentAvailabilityError({ enabled: true, channelScope: ['instagram'] }, 'instagram_comment')).toBeNull();
  });

  it('rejects ambiguous playbook transitions and identifies provider-event replays', () => {
    expect(validatePlaybookGraph({
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'trigger', data: {} },
        { id: 'done', type: 'complete', data: {} },
      ],
      edges: [
        { source: 'start', target: 'done' },
        { source: 'start', target: 'done' },
      ],
    })).toContain('Node start has more than one unconditional outgoing edge.');
    expect(isRepeatedPlaybookEvent({ lastEventKey: 'ig:123' }, 'ig:123')).toBe(true);
    expect(isRepeatedPlaybookEvent({ lastEventKey: 'ig:123' }, 'ig:124')).toBe(false);
  });

  it('automatically retries bounded idempotent reads but reconciles write/stuck outcomes', () => {
    const now = new Date('2026-07-27T12:05:00Z');
    expect(decideToolRecovery({
      status: 'failed',
      riskLevel: 'read',
      attemptCount: 1,
      lastAttemptAt: '2026-07-27T12:04:00Z',
    }, now)).toBe('retry');
    expect(decideToolRecovery({
      status: 'running',
      riskLevel: 'write',
      attemptCount: 1,
      lastAttemptAt: '2026-07-27T12:00:00Z',
    }, now)).toBe('reconcile');
    expect(decideToolRecovery({
      status: 'failed',
      riskLevel: 'high',
      attemptCount: 1,
      reconciliationStatus: 'confirmed_not_executed',
    }, now)).toBe('retry');
  });

  it('marks both internal assistant surfaces as non-delivering advisory mode', () => {
    expect(INTERNAL_SUPPORT_ASSIST_SCOPE).toEqual({
      mode: 'advisory',
      deliveryAllowed: false,
      canonicalCustomerPipeline: 'ChannelGateway',
    });
  });

  it('guards every direct agent-configuration endpoint with support_ai entitlement', () => {
    const routes = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    const directAgentRoutes = routes.split('\n').filter((line) => line.includes('/api/settings/ai-agents'));
    expect(directAgentRoutes.length).toBe(8);
    for (const route of directAgentRoutes) expect(route).toContain('requireSupportAi');
  });

  it('migration normalizes legacy rate rules and installs one-active-run concurrency protection', async () => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        statements.push({ text, values });
        if (text.includes('SELECT id, escalation_rules FROM ai_agent_configs')) {
          return {
            rows: [{
              id: 3,
              escalation_rules: [{
                id: 'legacy',
                type: 'rate_limit',
                enabled: true,
                config: { maxMessages: 5, windowMinutes: 2, action: 'escalate' },
              }],
            }],
          };
        }
        return { rows: [] };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await governanceMigration(client as any);
    const normalizedUpdate = statements.find((statement) =>
      statement.text.includes('UPDATE ai_agent_configs SET escalation_rules'));
    expect(String(normalizedUpdate?.values?.[0])).toContain('"limit":5');
    expect(String(normalizedUpdate?.values?.[0])).toContain('"windowSeconds":120');
    expect(statements.some((statement) =>
      statement.text.includes('support_playbook_runs_active_conversation_uq')
      && statement.text.includes("WHERE status = 'active'"))).toBe(true);
    expect(statements.some((statement) =>
      statement.text.includes('managedAssignmentAlignmentVersion'))).toBe(true);
  });

  it('migration enforces one active agent and explicit dormant playbook ownership', async () => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (text: string) => { statements.push(text); return { rows: [] }; }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await singleActiveMigration(client as any);
    expect(statements.some((text) => text.includes('ai_agent_configs_one_enabled_per_user') && text.includes('WHERE enabled = TRUE'))).toBe(true);
    expect(statements.some((text) => text.includes('ADD COLUMN IF NOT EXISTS agent_type'))).toBe(true);
    expect(statements.some((text) => text.includes("SET enabled = (changed.rn = 1)"))).toBe(true);
    expect(statements.some((text) => text.includes('a.agent_type IS DISTINCT FROM p.agent_type'))).toBe(true);
    expect(statements.some((text) => text.includes('agent_config.active_agent_normalized'))).toBe(true);
    expect(statements.some((text) => text.includes('playbook_assignment.cross_agent_disabled'))).toBe(true);
    expect(statements.some((text) => text.includes('priority NULLS LAST'))).toBe(true);
    expect(statements.some((text) => text.includes('support_playbooks_user_agent_name_uq'))).toBe(true);
  });
});
