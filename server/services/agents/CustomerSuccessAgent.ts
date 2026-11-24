import { runSupportToolCalls } from './orchestration/SupportToolCallRunner.js';
/**
 * CustomerSuccessAgent.ts
 *
 * Post-sale / post-booking customer success agent.
 * Composes knowledge_base, ticket, and escalation sub-agents.
 */

import { BaseOutreachAgent, type AgentInput, type AgentResult, type SupportEffectProposal } from './BaseOutreachAgent.js';
import { buildFewShotMessages } from '../../utils/agentPromptBuilder.js';
import { logger } from '../../utils/logger.js';
import { LLMProviderFactory } from './LLMProviderFactory.js';
import type { SubAgentContext } from './subagents/SubAgentBase.js';
import { nluService } from './NLUService.js';
import { salesIntelligence } from './SalesIntelligence.js';

const LOG_PREFIX = '[CustomerSuccessAgent]';

const DEFAULT_SYSTEM_PROMPT = `You are a Customer Success Agent. Your goal is to ensure customers are delighted with their experience. Check on satisfaction, proactively address concerns, share tips and resources from the knowledge base, and identify upsell or renewal opportunities. Be warm, empathetic, and solution-oriented.`;

const MAX_TURNS = 4;

export class CustomerSuccessAgent extends BaseOutreachAgent {
  readonly agentName = 'CustomerSuccessAgent';

  constructor() {
    super();
    this.subAgentIds = ['knowledge_base', 'ticket', 'proposal', 'escalation'];
  }

  async handle(input: AgentInput): Promise<AgentResult> {
    const { userId, conversationId, inboundText } = input;
    logger.info({ conversationId, userId }, `${LOG_PREFIX} Handling inbound message`);

    const kbContext = input.kbContext?.join('\n\n') || '';

    // ── 2. Build guidelines suffix ──
    const customerInfoLines: string[] = [];
    if (input.leadName) customerInfoLines.push('Customer Name: [NAME_1]');
    if (input.leadCompany) customerInfoLines.push(`Company: ${input.leadCompany}`);

    const suffixParts: string[] = [];

    if (customerInfoLines.length > 0) {
      suffixParts.push(`--- CUSTOMER INFO ---\n${customerInfoLines.join('\n')}\n---------------------`);
    }

    if (kbContext) {
      suffixParts.push(kbContext);
    }
    if (input.playbookDirective?.instruction) suffixParts.push(`--- PUBLISHED PLAYBOOK REQUIREMENT ---\n${input.playbookDirective.instruction}`);
    if (input.platformInstructions) suffixParts.push(`--- PLATFORM OUTPUT CONTRACT ---\n${input.platformInstructions}`);

    const personaRules = input.channel === 'email'
      ? '• EMAIL FORMATTING: Output the email body in clean, professional HTML (using <p>, <br>, <b>, <i> tags). DO NOT use Markdown. Do NOT include a subject line.\n• SIGN-OFF: Sign off professionally using the sender\'s name.'
      : '• MULTI-MESSAGE SPLITTING: If your response is long or contains multiple distinct thoughts/steps (e.g. greeting, success strategies, asking questions), you can separate them into multiple messages using three pipes \' ||| \' (e.g. "Hi there! ||| Let\'s configure this together... ||| What is your primary objective?"). Each section will be delivered as a separate message bubble to the customer.';

    suffixParts.push(
      `--- GUIDELINES ---\n` +
      `• Reply in the same language as the customer.\n` +
      `• Keep replies concise, warm, and actionable.\n` +
      `• If you are unsure, ask a clarifying question rather than guessing.\n` +
      `• Never fabricate product details — only reference information from the knowledge base.\n` +
      `• If the customer is unhappy, acknowledge their feelings before offering solutions.\n` +
      `• TOOL FAILURES: If any tool call fails or returns an error, do NOT retry the tool call in a loop. Politely apologize to the customer, explain there is a temporary technical issue, and offer to escalate to a human representative.\n` +
      // eslint-disable-next-line no-useless-escape
      `• UNKNOWN CUSTOMER GREETING: If the customer\'s name is unknown, missing, or a placeholder (like "Guest"), do NOT say "Hello Guest" or greet them by a placeholder name. Instead, welcome them politely and immediately ask for their name and any missing contact details (e.g. phone or email) before proceeding.\n` +
      `• COMPLIMENTARY SERVICES: Never promise or offer any complimentary services, free features, or free trials unless they are explicitly verified and retrieved from the knowledge base.\n` +
      `• DISCOUNTS: Never offer or agree to any discounts or pricing concessions unless they are explicitly authorized in the retrieved knowledge base.\n` +
      `• ${personaRules}\n` +
      `-------------------`,
    );

    const channelRules = suffixParts.find((part) => part.startsWith('--- GUIDELINES ---')) || '';
    const verifiedContext = suffixParts.filter((part) =>
      !part.startsWith('--- GUIDELINES ---')
      && !part.startsWith('--- PUBLISHED PLAYBOOK REQUIREMENT ---')
      && !part.startsWith('--- PLATFORM OUTPUT CONTRACT ---'),
    ).join('\n\n');

    // ── 3. Build messages array ──
    const messages = buildFewShotMessages({
      agentConfig: input.agentConfig ?? null,
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
      agentConfig: input.agentConfig || null,
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
      const selectedModel = input.agentConfig?.modelOverride || provider.defaultModel;
      const turnTools = this.toolsForGenerationTurn(input, tools, toolCallsExecuted.length);
      const response = this.requiredToolResponse(input, turnTools, toolCallsExecuted.length) || await LLMProviderFactory.createChatCompletionWithFallback(userId, {
        model: selectedModel,
        messages,
        tools: turnTools.length > 0 ? turnTools : undefined,
        tool_choice: turnTools.length > 0 ? (input.playbookDirective?.requiredAction ? 'required' : 'auto') : undefined,
        temperature: 0.5,
        max_tokens: 1024,
        loggingContext: {
          userId,
          threadId: conversationId,
          purpose: 'customer_success_agent',
          service: 'CustomerSuccessAgent',
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
          escalationReason = out.escalationReason;
          escalationType = out.escalationType;
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

    // ── 5. Determine CRM pipeline status ──
    const sentimentLabel = input.sentiment?.sentiment;
    if (!crmPipelineStatus) {
      if (sentimentLabel === 'negative') {
        crmPipelineStatus = 'ticket_open';
        logger.info({ conversationId, sentimentLabel }, `${LOG_PREFIX} Negative sentiment → ticket_open`);
      } else {
        crmPipelineStatus = 'contacted';
        logger.info({ conversationId }, `${LOG_PREFIX} Default contacted status`);
      }
    }

    return {
      replyText,
      escalated,
      escalationReason,
      escalationType,
      intent: 'customer_success',
      crmPipelineStatus,
      scheduleReminder,
      toolCallsExecuted,
      effectProposals,
      outcome: sentimentLabel === 'negative' ? 'attention_required' : 'case_active',
      confidenceReason: sentimentLabel === 'negative'
        ? 'Negative sentiment requires explicit ownership and next-action review.'
        : 'No verified closure or follow-up consent was supplied.',
      followUp: { eligible: !escalated, consent: 'unknown' },
      generationMetadata,
    };
  }
}

export const customerSuccessAgent = new CustomerSuccessAgent();
