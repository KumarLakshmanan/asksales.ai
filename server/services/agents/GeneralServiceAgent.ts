import { runSupportToolCalls } from './orchestration/SupportToolCallRunner.js';
/**
 * GeneralServiceAgent.ts
 *
 * A specialized outreach agent for general customer service and FAQs.
 * Composes knowledge_base and escalation sub-agents.
 */

import { BaseOutreachAgent, type AgentInput, type AgentResult, type SupportEffectProposal } from './BaseOutreachAgent.js';
import { buildFewShotMessages } from '../../utils/agentPromptBuilder.js';
import { logger } from '../../utils/logger.js';
import { LLMProviderFactory } from './LLMProviderFactory.js';
import type { SubAgentContext } from './subagents/SubAgentBase.js';
import { nluService } from './NLUService.js';
import { salesIntelligence } from './SalesIntelligence.js';

const LOG_PREFIX = '[GeneralServiceAgent]';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful customer service agent. Answer questions accurately using the knowledge base tools. ' +
  'Be professional, friendly, and concise. If you cannot fully answer, use the configured human-handoff path. Do not claim that another AI specialist was selected. Always provide a clear next step.';

const MAX_TURNS = 4;

export class GeneralServiceAgent extends BaseOutreachAgent {
  readonly agentName = 'GeneralServiceAgent';

  constructor() {
    super();
    this.subAgentIds = ['knowledge_base', 'proposal', 'escalation'];
  }

  async handle(input: AgentInput): Promise<AgentResult> {
    const { userId, conversationId, inboundText, leadName, leadCompany, agentConfig } = input;

    logger.info(
      { userId, conversationId, channel: input.channel },
      `${LOG_PREFIX} Handling inbound general customer service message`
    );

    const kbContext = input.kbContext?.join('\n\n') || '';

    // ── 2. Build guidelines suffix ──
    const guidelinesParts: string[] = [];

    if (leadName || leadCompany) {
      const parts: string[] = [];
      if (leadName) parts.push('Name: [NAME_1]');
      if (leadCompany) parts.push(`Company: ${leadCompany}`);
      guidelinesParts.push(`### Customer Info\n${parts.join('\n')}`);
    }

    if (kbContext) {
      guidelinesParts.push(kbContext);
    }
    if (input.playbookDirective?.instruction) guidelinesParts.push(`### Published Playbook Requirement\n${input.playbookDirective.instruction}`);
    if (input.platformInstructions) guidelinesParts.push(`### Platform Output Contract\n${input.platformInstructions}`);

    const personaRules = input.channel === 'email'
      ? '- EMAIL FORMATTING: Output the email body in clean, professional HTML (using <p>, <br>, <b>, <i> tags). DO NOT use Markdown. Do NOT include a subject line.\n- SIGN-OFF: Sign off professionally using the sender\'s name.'
      : '- MULTI-MESSAGE SPLITTING: If your response is long or contains multiple distinct thoughts/steps (e.g. greeting, answering the question, follow-up), you can separate them into multiple messages using three pipes \' ||| \' (e.g. "Hi there! ||| To answer your question... ||| Let me know if you need anything else."). Each section will be delivered as a separate message bubble to the customer.';

    guidelinesParts.push(
      '### Response Guidelines\n' +
        '- Keep replies under 300 characters.\n' +
        '- Do NOT use placeholder values (e.g. [name], {company}).\n' +
        '- Be concise, helpful, and polite.\n' +
        '- Answer the customer\'s question directly using the knowledge base.\n' +
        '- If you do not have enough info, politely say you don\'t know and offer to connect them with a human specialist.\n' +
        '- TOOL FAILURES: If any tool call fails or returns an error, do NOT retry the tool call in a loop. Politely apologize to the customer, explain there is a temporary technical issue, and offer to escalate to a human representative.\n' +
        '- UNKNOWN CUSTOMER GREETING: If the customer\'s name is unknown, missing, or a placeholder (like "Guest"), do NOT say "Hello Guest" or greet them by a placeholder name. Instead, welcome them politely and immediately ask for their name and any missing contact details (e.g. phone or email) before proceeding.\n' +
        '- COMPLIMENTARY SERVICES: Never promise or offer any complimentary services, free features, or free trials unless they are explicitly verified and retrieved from the knowledge base.\n' +
        '- DISCOUNTS: Never offer or agree to any discounts or pricing concessions unless they are explicitly authorized in the retrieved knowledge base.\n' +
        personaRules
    );

    const channelRules = guidelinesParts.find((part) => part.startsWith('### Response Guidelines')) || '';
    const verifiedContext = guidelinesParts.filter((part) =>
      !part.startsWith('### Response Guidelines')
      && !part.startsWith('### Published Playbook Requirement')
      && !part.startsWith('### Platform Output Contract'),
    ).join('\n\n');

    // ── 3. Build messages array ──
    const messages = buildFewShotMessages({
      agentConfig: agentConfig ?? null,
      fallbackSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      inboundText,
      channelRules,
      playbookInstruction: input.playbookDirective?.instruction,
      verifiedContext,
      platformInstructions: input.platformInstructions,
      conversationHistory: input.conversationHistory,
      guestName: input.leadName ? '[NAME_1]' : undefined,
    });

    let provider;
    try {
      provider = await LLMProviderFactory.createProviderForUser(userId);
    } catch (err) {
      logger.error({ err, userId }, `${LOG_PREFIX} Provider creation failed`);
      return { replyText: this.fallbackReply(), escalated: true, escalationReason: 'AI provider unavailable', confidence: 0 };
    }

    // Fetch memory/intel for sub-agent context
    const slots = {};
    const priorMemory = await salesIntelligence.loadMemory(input.leadId);
    const nlu = input.nlu || await nluService.analyze(userId, inboundText);
    const intel = salesIntelligence.computeIntelligence(nlu, slots, priorMemory);

    const subAgentCtx: SubAgentContext = {
      userId,
      conversationId,
      channel: input.channel,
      inboundText,
      rawMessageId: input.rawMessageId,
      messageId: input.messageId,
      nlu,
      slots,
      memory: priorMemory,
      intel,
      lead: {
        id: input.leadId,
        name: input.operationalIdentity ? input.operationalIdentity.leadName : input.leadName,
        company: input.operationalIdentity ? input.operationalIdentity.leadCompany : input.leadCompany,
        recipientPhone: input.operationalIdentity ? input.operationalIdentity.recipientPhone : input.recipientPhone,
      },
      agentConfig: agentConfig || null,
      businessProfileId: input.businessProfileId,
      knowledgeResult: input.contextLanes?.knowledge,
      history: input.conversationHistory || [],
      playbookDirective: input.playbookDirective || null,
      dryRun: input.dryRun,
      executionMode: input.executionMode,
      widgetSession: input.widgetSession,
      isSupportChat: input.isSupportChat,
    };

    let replyText: string | null = null;
    let escalated = false;
    let escalationReason: string | undefined;
    let escalationType: 'sales' | 'support' | undefined;
    let crmPipelineStatus: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scheduleReminder: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCallsExecuted: any[] = [];
    const effectProposals: SupportEffectProposal[] = [];
    let generationMetadata: AgentResult['generationMetadata'];

    const tools = this.toolsForInput(input);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const selectedModel = agentConfig?.modelOverride || provider.defaultModel;
      const turnTools = this.toolsForGenerationTurn(input, tools, toolCallsExecuted.length);
      const response = this.requiredToolResponse(input, turnTools, toolCallsExecuted.length) || await LLMProviderFactory.createChatCompletionWithFallback(userId, {
        model: selectedModel,
        messages,
        tools: turnTools.length > 0 ? turnTools : undefined,
        tool_choice: turnTools.length > 0 ? (input.playbookDirective?.requiredAction ? 'required' : 'auto') : undefined,
        temperature: 0.4,
        max_tokens: 300,
        loggingContext: {
          userId,
          purpose: 'general_service_reply',
          service: 'GeneralServiceAgent',
          action: 'handle',
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      generationMetadata = { provider: response.completion?.provider || (typeof provider.getProviderName === 'function' ? provider.getProviderName() : 'unknown'), model: response.completion?.model || selectedModel, promptTokens: response.usage?.promptTokens, completionTokens: response.usage?.completionTokens, totalTokens: response.usage?.totalTokens };

      const msg = response.completion?.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        replyText = (response.content || msg?.content || '').trim() || null;
        break;
      }

      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls });

      for await (const { tc, args, out, durationMs } of runSupportToolCalls(toolCalls,
        (name, args) => this.dispatchToSubAgent(name, args, subAgentCtx,
          this.toolsForGenerationTurn(input, turnTools, toolCallsExecuted.length).map(tool => tool.function?.name || '')),
        { requiredAction: input.playbookDirective?.requiredAction })) {
        if (out.escalated) {
          escalated = true;
          if (out.escalationType === 'sales' || escalationType !== 'sales') {
            escalationReason = out.escalationReason;
            escalationType = out.escalationType;
          }
        }
        if (out.crmPipelineStatus) {
          crmPipelineStatus = out.crmPipelineStatus;
        }
        if (out.scheduleReminder) {
          scheduleReminder = out.scheduleReminder;
        }
        if (out.effectProposals?.length) effectProposals.push(...out.effectProposals);

        const toolRes = out.toolResults?.[0];
        toolCallsExecuted.push({ ...this.recordToolOutcome(tc.function.name, args, out), toolCallId: tc.id, durationMs });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(toolRes ? toolRes.result : { success: false, code: 'missing_tool_result' }),
        });
      }
    }

    if (!replyText) replyText = this.fallbackReply();

    // ── 5. Detect if unresolved ──
    const factualRequest = ['faq', 'pricing_question', 'support_request', 'ticket_status'].includes(nlu.intent);
    const isUnresolved = escalated || (factualRequest
      && input.contextLanes?.knowledge?.status !== 'sufficient'
      && !toolCallsExecuted.some(tool => tool.success && tool.status === 'success'));

    if (!crmPipelineStatus) {
      crmPipelineStatus = 'contacted';
    }

    return {
      replyText,
      escalated,
      escalationReason,
      escalationType,
      intent: 'general_service',
      crmPipelineStatus,
      scheduleReminder,
      toolCallsExecuted,
      effectProposals,
      outcome: isUnresolved ? 'insufficient_information' : 'answered',
      confidenceReason: isUnresolved
        ? 'The structured retrieval/tool outcome does not establish a verified answer.'
        : 'A customer-ready response was generated from the available context.',
      groundingStatus: input.kbContext?.length ? 'grounded' : 'insufficient_knowledge',
      followUp: { eligible: isUnresolved && !escalated, consent: 'unknown' },
      generationMetadata,
    };
  }
}

export const generalServiceAgent = new GeneralServiceAgent();
