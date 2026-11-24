import { beforeEach, describe, expect, it, jest } from '@jest/globals';
let enabled = true;
let assistant:
  | {
      preview?: boolean;
      configuration: unknown;
      provenance: Record<string, unknown>;
    }
  | undefined;
const verify = jest.fn<(...args: any[]) => Promise<boolean>>();
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({
  currentAssistant: () => assistant,
  assistantsRuntimeEnabled: () => enabled,
  assistantDeliveryMetadata: () =>
    assistant ? { assistant: assistant.provenance } : {},
}));
jest.unstable_mockModule(
  '../services/assistants/AssistantFreshness.js',
  () => ({
    assistantDeliveryCurrent: verify,
    assistantProvenanceCurrent: verify,
  }),
);
jest.unstable_mockModule('../services/assistants/AssistantResolver.js', () => ({
  assistantAgentConfig: () => ({ agentType: 'general_service' }),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const { AgentConfigurationStage } =
  await import('../services/agents/pipeline/stages/AgentConfigurationStage.js');
const { automaticSupportReplyAllowed } =
  await import('../services/agents/orchestration/SupportAutoReplyService.js');
const ctx = () => ({
  message: {
    userId: 9,
    conversationId: 68,
    channel: 'email' as const,
    senderIdentifier: 'lead@example.test',
    inboundText: 'Hello',
  },
  confidence: 1,
  policyViolations: [],
});
beforeEach(() => {
  enabled = true;
  assistant = undefined;
  verify.mockReset().mockResolvedValue(true);
});
describe('published assistant routing only', () => {
  it('requires an explicit assignment instead of selecting or provisioning a business-global agent', async () => {
    await expect(
      new AgentConfigurationStage().execute(ctx()),
    ).rejects.toMatchObject({ outcome: 'no_op' });
    expect(await automaticSupportReplyAllowed(9, 'email')).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it('uses only the resolved assignment and rechecks its account before delivery', async () => {
    assistant = {
      configuration: {},
      provenance: {
        assistantId: 'assigned',
        channel: 'email',
        surface: 'private',
        accountId: 'sender@example.test',
        bindingId: 1,
        revision: 1,
      },
    };
    expect(await new AgentConfigurationStage().execute(ctx())).toMatchObject({
      metadata: { agentConfig: { agentType: 'general_service' } },
    });
    expect(
      await automaticSupportReplyAllowed(9, 'email', 'other@example.test'),
    ).toBe(false);
    expect(
      await automaticSupportReplyAllowed(9, 'email', 'sender@example.test'),
    ).toBe(true);
    enabled = false;
    expect(
      await automaticSupportReplyAllowed(9, 'email', 'sender@example.test'),
    ).toBe(false);
  });
});
