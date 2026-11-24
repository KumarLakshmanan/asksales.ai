import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_SUPPORT_AGENT_PROFILES,
  DEFAULT_SUPPORT_PLAYBOOKS,
  enforceMandatoryAgentControls,
  SUPPORT_AGENT_TYPES,
} from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { validatePlaybookGraph } from '../services/agents/orchestration/PlaybookEngine.js';
import { SUPPORT_INTENTS } from '../services/agents/NLUService.js';
import {
  enforcePlaybookControlMetadata,
  isManagedTemplateCopy,
  validateSupportTemplateInput,
} from '../services/agents/orchestration/SupportPlaybookTemplateService.js';
import { validateSupportAgentTemplate } from '../services/agents/orchestration/SupportAgentTemplateService.js';
import { isLegacyUnlinkedAgentConfig } from '../services/agents/orchestration/DefaultSupportProvisioningService.js';

describe('default support configuration', () => {
  it('provides the specialist starters and three proposal journeys for every support specialist', () => {
    expect(DEFAULT_SUPPORT_PLAYBOOKS).toHaveLength(25);
    for (const agentType of SUPPORT_AGENT_TYPES) {
      expect(DEFAULT_SUPPORT_PLAYBOOKS.filter((playbook) => playbook.agentType === agentType)).toHaveLength(5);
    }
    for (const playbook of DEFAULT_SUPPORT_PLAYBOOKS) {
      expect(validatePlaybookGraph(playbook.graph)).toEqual([]);
      expect(playbook.assignments.length).toBeGreaterThan(0);
      expect(playbook.assignments.every((assignment) => assignment.agentType === playbook.agentType)).toBe(true);
    }
  });

  it('marks mandatory privacy, safety, PII, handoff, and approval controls on every default', () => {
    for (const playbook of DEFAULT_SUPPORT_PLAYBOOKS) {
      expect(playbook.graph.metadata).toMatchObject({
        templateKey: playbook.key,
        templateVersion: expect.any(Number),
        systemDefault: true,
        agentType: playbook.agentType,
        controls: {
          privacy: 'enforced',
          piiRedaction: 'enforced',
          safety: 'enforced',
          humanHandoff: 'enabled',
          toolApproval: 'required',
        },
      });
    }
  });

  it('assigns each default only to classifier intents the runtime supports', () => {
    const assignments = DEFAULT_SUPPORT_PLAYBOOKS.flatMap((playbook) =>
      playbook.assignments,
    );
    expect(new Set(assignments.map(assignment => `${assignment.agentType}:${assignment.intent}`)).size).toBe(assignments.length);
    for (const assignment of assignments) expect(SUPPORT_INTENTS).toContain(assignment.intent);
  });

  it('seeds all agents with mandatory safety policy and no automatic high-risk approval', () => {
    expect(DEFAULT_SUPPORT_AGENT_PROFILES.map((profile) => profile.type).sort())
      .toEqual([...SUPPORT_AGENT_TYPES].sort());
    for (const profile of DEFAULT_SUPPORT_AGENT_PROFILES) {
      expect(profile.channels).toEqual(expect.arrayContaining(['email', 'whatsapp', 'instagram', 'facebook', 'web']));
      expect(profile.escalationRules.map((rule) => rule.type)).toEqual(expect.arrayContaining([
        'prohibited_topics',
        'escalation_threshold',
        'max_response_length',
        'rate_limit',
        'auto_escalate_intent',
      ]));
      expect(profile.metadata).toMatchObject({
        privacyStatus: 'enforced',
        safetyStatus: 'enforced',
        handoffStatus: 'enabled',
        toolApprovalStatus: 'required',
        autoApproveTools: [],
      });
      expect(profile.prompt).toContain('Never request or repeat passwords');
    }
  });

  it('keeps specialist activation opt-in while publishing their ready assignments', () => {
    const enabled = DEFAULT_SUPPORT_AGENT_PROFILES.filter((profile) => profile.enabledByDefault);
    expect(enabled.map((profile) => profile.type)).toEqual(['general_service']);
    expect(DEFAULT_SUPPORT_PLAYBOOKS.every((playbook) =>
      playbook.assignments.every((assignment) => assignment.trafficPercent === 100),
    )).toBe(true);
  });

  it('preserves custom policy while restoring mandatory controls on existing agents', () => {
    const result = enforceMandatoryAgentControls('hotel_sales', {
      reviewMode: 'strict',
      rules: [
        { id: 'owner-business-hours', type: 'operating_hours', enabled: true, config: { timezone: 'UTC' } },
        { id: 'default-hotel_sales-confidence', type: 'escalation_threshold', enabled: false, config: { threshold: 0.1 } },
      ],
    }, { ownerSetting: 'preserved', safetyStatus: 'disabled' });
    const rules = (result.escalationRules as { rules: Array<{ id: string; enabled: boolean; config: Record<string, unknown> }> }).rules;
    expect(result.escalationRules).toMatchObject({ reviewMode: 'strict' });
    expect(rules).toContainEqual(expect.objectContaining({ id: 'owner-business-hours' }));
    expect(rules).toContainEqual(expect.objectContaining({
      id: 'default-hotel_sales-confidence',
      enabled: false,
      config: { threshold: 0.1 },
    }));
    expect(result.metadata).toMatchObject({
      ownerSetting: 'preserved',
      privacyStatus: 'enforced',
      safetyStatus: 'enforced',
      toolApprovalStatus: 'required',
    });
  });

  it('propagates only to tenant copies that are still admin managed', () => {
    expect(isManagedTemplateCopy('managed')).toBe(true);
    expect(isManagedTemplateCopy('customized')).toBe(false);
    expect(isManagedTemplateCopy('custom')).toBe(false);
    expect(isManagedTemplateCopy('managed', 'archived')).toBe(false);
    expect(isManagedTemplateCopy('managed', 'published')).toBe(true);
  });

  it('preserves provenance while enforcing non-disableable controls on client forks', () => {
    const graph = enforcePlaybookControlMetadata(DEFAULT_SUPPORT_PLAYBOOKS[0].graph, {
      templateKey: 'hotel-availability-booking',
      templateVersion: 3,
      agentType: 'hotel_sales',
      systemDefault: false,
    });
    expect(graph.metadata).toMatchObject({
      templateKey: 'hotel-availability-booking',
      templateVersion: 3,
      systemDefault: false,
      controls: { privacy: 'enforced', piiRedaction: 'enforced', safety: 'enforced' },
    });
  });

  it('rejects admin templates with unknown routing intents', () => {
    const source = DEFAULT_SUPPORT_PLAYBOOKS[0];
    expect(validateSupportTemplateInput({
      templateKey: source.key,
      name: source.name,
      description: source.description,
      agentType: source.agentType,
      graph: source.graph,
      assignments: [{ ...source.assignments[0], intent: 'not_a_runtime_intent' }],
    })).toContain('Unsupported intent: not_a_runtime_intent.');
  });

  it('validates global agent policy templates before propagation', () => {
    const profile = DEFAULT_SUPPORT_AGENT_PROFILES[0];
    expect(validateSupportAgentTemplate({
      agentType: profile.type,
      displayName: profile.name,
      description: profile.description,
      systemPrompt: profile.prompt,
      toolsEnabled: profile.toolsEnabled,
      escalationRules: profile.escalationRules,
      channelScope: profile.channels,
      priority: profile.priority,
      metadata: profile.metadata,
    })).toEqual([]);
  });

  it('repairs only unlinked empty-tool starter rows', () => {
    expect(isLegacyUnlinkedAgentConfig({
      templateMode: 'custom',
      templateVersion: null,
      toolsEnabled: [],
      modelOverride: null,
      metadata: { mandatoryControlProfileVersion: 1, trainingConversations: [{ id: 'kept' }] },
    })).toBe(true);
    expect(isLegacyUnlinkedAgentConfig({
      templateMode: 'customized',
      templateVersion: 1,
      toolsEnabled: [],
      modelOverride: null,
      metadata: { mandatoryControlProfileVersion: 1 },
    })).toBe(false);
    expect(isLegacyUnlinkedAgentConfig({
      templateMode: 'custom',
      templateVersion: null,
      toolsEnabled: ['answer_from_knowledge_base'],
      modelOverride: null,
      metadata: { mandatoryControlProfileVersion: 1 },
    })).toBe(false);
  });
});
