import { runSupportToolCalls } from './orchestration/SupportToolCallRunner.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HotelSalesAgent — a tool-using LLM agent for hotel Sales & Support.
 * Works across all outreach channels (WhatsApp, Instagram, Facebook, Email).
 *
 * It composes sub-agents (booking, negotiation, complaint, etc.) and orchestrates
 * the LLM function-calling loop.
 */

import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../utils/timezone.js';
import { redactPiiWithStableTokens } from './orchestration/PrivacyVaultService.js';
import { LLMProviderFactory } from './LLMProviderFactory.js';
import { hotelHistoryService } from '../booking/HotelHistoryService.js';
import { nluService, type NLUResult } from './NLUService.js';
import { salesIntelligence, type CustomerMemory, type LeadIntelligence } from './SalesIntelligence.js';
import { getDynamicHotelContext } from '../../mastra/agents/supportAgent.js';
import { buildFewShotMessages, type AgentConfigLike } from '../../utils/agentPromptBuilder.js';
import { BaseOutreachAgent, type AgentInput, type AgentResult, type ExternalBookingHandoff, type SupportEffectProposal } from './BaseOutreachAgent.js';
import {
  getHotelPaymentConfiguration,
  isMockPaymentAllowed,
} from '../booking/PaymentProvider.js';
import type { SubAgentContext } from './subagents/SubAgentBase.js';
import { hotelNegotiationToolPolicy } from './orchestration/HotelToolPolicy.js';
import {
  renderVerifiedHotelAvailabilityOptions,
  renderVerifiedHotelBookingSummary,
  renderVerifiedHotelPaymentMethods,
} from '../booking/HotelBookingSummary.js';

export type SalesAgentInput = AgentInput;
export type SalesAgentResult = AgentResult;

/** An explicitly empty history is an authorization boundary, not a request to
 * reload the conversation from storage. Ticket-aware FAQ turns use this to
 * prevent an older booking or question from leaking into the current answer. */
export function resolveAgentConversationHistory<T>(
  provided: T[] | undefined,
  loaded: T[],
): T[] {
  return provided === undefined ? loaded : provided;
}

/** AI identifies availability intent; validated extracted dates determine
 * whether the owner simulator can offer the read-only availability tool. */
export function shouldRequireOwnerAvailabilityRead(input: Pick<AgentInput,
  'executionMode' | 'isSupportChat' | 'inboundText' | 'nlu'>): boolean {
  if (input.executionMode !== 'advisory' || input.isSupportChat !== true) return false;
  const nlu = input.nlu;
  if (!nlu || nlu.classificationConfidence < 0.85 || !['availability_inquiry', 'booking_request'].includes(nlu.intent)) return false;
  const args = normalizeOwnerAvailabilityReadArgs(nlu.entities, {});
  return typeof args.check_in === 'string' && typeof args.check_out === 'string';
}

/** Keep the owner tester's required availability read faithful to explicit
 * search fields in the message. In particular, day-use searches legitimately
 * have one date, which is both check-in and check-out for the booking engine. */
export function normalizeOwnerAvailabilityReadArgs(
  entities: Record<string, unknown>,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const args = { ...supplied };
  const isoDate = (value: unknown): string | undefined => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
  const checkIn = isoDate(entities.checkIn), checkOut = isoDate(entities.checkOut);
  const isDayUse = entities.stayType === 'dayuse';
  if (checkIn) args.check_in = checkIn;
  if (isDayUse && checkIn) {
    args.check_out = checkIn;
    args.stay_type = 'dayuse';
  } else if (checkOut) {
    args.check_out = checkOut;
    args.stay_type = 'overnight';
  }
  for (const key of ['adults', 'children', 'guests', 'rooms']) {
    if (Number.isSafeInteger(entities[key]) && Number(entities[key]) >= 0) args[key] = entities[key];
  }
  if (Number.isSafeInteger(args.adults)) args.guests = Number(args.adults) + Number(args.children || 0);
  if (typeof entities.promoCode === 'string') args.promo_code = entities.promoCode;
  if (typeof entities.currency === 'string') args.currency = entities.currency.toUpperCase();
  return args;
}

export function isAvailabilitySelectionBoundary(playbookNodeId: string | undefined,
  requireOwnerAvailabilityRead: boolean): boolean {
  return requireOwnerAvailabilityRead
    || playbookNodeId === 'check-availability'
    || playbookNodeId === 'check-alternative-dates'
    || playbookNodeId === 'check-alternative-room';
}

const MAX_TURNS = 6;
const LARGE_GROUP_ROOMS = Number(process.env.SALES_LARGE_GROUP_ROOMS || 5);

interface TurnContext {
  memory: CustomerMemory;
  intel: LeadIntelligence;
  nlu: NLUResult;
}

interface HotelContext {
  name: string;
  city: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
  amenities: string[];
  checkInTime: string | null;
  checkOutTime: string | null;
}

interface SlotState {
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  rooms?: number;
  roomTypeId?: number;
  roomTypeName?: string;
  guestName?: string;
  guestPhone?: string;
  guestEmail?: string;
  specialRequests?: string;
  agreedPricePerNight?: number;
  negotiationRound?: number;
  perksOffered?: string[];
  agreedPerks?: string[];
  availabilityCheckedAt?: string;
  availabilityExpiresAt?: string;
  availableRoomTypeIds?: number[];
  quotedPricesByRoomType?: Record<string, number>;
  priceQuotedAt?: string;
  priceQuoteRoomTypeId?: number;
}

export class HotelSalesAgent extends BaseOutreachAgent {
  readonly agentName = 'HotelSalesAgent';

  constructor() {
    super();
    this.subAgentIds = [
      'booking',
      'negotiation',
      'complaint',
      'ticket',
      'payment',
      'escalation',
      'knowledge_base',
      'qualification',
      'proposal'
    ];
  }

  private isPlaceholderName(name: string | null | undefined): boolean {
    if (!name) return true;
    const trimmed = name.trim().toLowerCase();
    if (
      trimmed === '' ||
      trimmed === 'guest' ||
      trimmed === 'unknown' ||
      trimmed === 'user' ||
      trimmed === 'whatsapp guest' ||
      trimmed === 'email guest' ||
      trimmed === 'instagram user' ||
      trimmed === 'facebook user'
    ) {
      return true;
    }
    if (
      trimmed.startsWith('fb user') ||
      trimmed.startsWith('ig user') ||
      trimmed.startsWith('@')
    ) {
      return true;
    }
    return false;
  }

  async handle(input: SalesAgentInput): Promise<SalesAgentResult> {
    const { userId, conversationId, inboundText } = input;
    const channel = input.channel || 'whatsapp';
    const operationalLeadName = input.operationalIdentity
      ? input.operationalIdentity.leadName ?? null
      : input.leadName ?? null;
    const operationalRecipient = input.operationalIdentity
      ? input.operationalIdentity.recipientPhone ?? null
      : input.recipientPhone ?? null;

    const state = input.isSupportChat
      ? { slots: {} }
      : await this.loadState(userId, conversationId);
    const slots: SlotState = state.slots || {};

    // ── Lead Verification, Lookup and Auto-Creation ──
    let leadId = input.leadId;
    let leadName: string | null = null;
    let leadPhone: string | null = null;
    let leadEmail: string | null = null;

    if (input.isSupportChat || input.dryRun) {
      leadName = operationalLeadName || 'Guest';
      leadPhone = operationalRecipient;
      leadId = null;
    } else {
      if (leadId) {
        try {
          const leadRows = await db.execute(sql`
            SELECT id, name, first_name, phone, email
            FROM leads
            WHERE id = ${leadId} AND user_id = ${userId} AND deleted_at IS NULL
            LIMIT 1
          `);
          if (leadRows.rows.length > 0) {
             
            const leadRow = leadRows.rows[0] as any;
            leadName = leadRow.name || leadRow.first_name || null;
            leadPhone = leadRow.phone || null;
            leadEmail = leadRow.email || null;
          } else {
            leadId = null;
          }
        } catch (err) {
          logger.error({ err, leadId }, '[HotelSalesAgent] Failed to fetch lead by ID');
          leadId = null;
        }
      }

      const handle = operationalRecipient;
      if (!leadId && handle) {
        try {
          let queryResult = null;
          if (channel === 'email') {
            queryResult = await db.execute(sql`
              SELECT id, name, first_name, phone, email FROM leads
              WHERE user_id = ${userId} AND email = ${handle} AND deleted_at IS NULL
              ORDER BY id ASC LIMIT 1
            `);
          } else if (channel === 'whatsapp') {
            const handlePlus = `+${handle}`;
            queryResult = await db.execute(sql`
              SELECT id, name, first_name, phone, email FROM leads
              WHERE user_id = ${userId} AND (phone = ${handle} OR phone = ${handlePlus} OR whatsapp = ${handle} OR whatsapp = ${handlePlus}) AND deleted_at IS NULL
              ORDER BY id ASC LIMIT 1
            `);
          } else if (channel === 'instagram') {
            queryResult = await db.execute(sql`
              SELECT id, name, first_name, phone, email FROM leads
              WHERE user_id = ${userId} AND (
                instagram = ${handle} 
                OR platform_extended->>'instagram_id' = ${handle}
              ) AND deleted_at IS NULL
              ORDER BY id ASC LIMIT 1
            `);
          } else if (channel === 'facebook') {
            queryResult = await db.execute(sql`
              SELECT id, name, first_name, phone, email FROM leads
              WHERE user_id = ${userId} AND (
                facebook = ${handle} 
                OR platform_extended->>'facebook_id' = ${handle}
              ) AND deleted_at IS NULL
              ORDER BY id ASC LIMIT 1
            `);
          }

          if (queryResult && queryResult.rows.length > 0) {
             
            const matched = queryResult.rows[0] as any;
            leadId = matched.id;
            leadName = matched.name || matched.first_name || null;
            leadPhone = matched.phone || null;
            leadEmail = matched.email || null;
            logger.info({ leadId, handle }, '[HotelSalesAgent] Resolved lead from conversation handles');
          }
        } catch (err) {
          logger.warn({ err, handle }, '[HotelSalesAgent] Failed to resolve lead by handle');
        }
      }

      if (!leadId) {
        // Identity creation is a durable CRM effect and must not occur inside
        // generation. The channel intake layer may provide a lead; otherwise
        // the agent continues without mutating CRM before safety/delivery.
        leadName = operationalLeadName;
        leadPhone = channel === 'whatsapp' ? handle || null : null;
        logger.info({ channel }, '[HotelSalesAgent] Continuing without a persisted lead identity');
      }
    }

    if (!slots.guestName && leadName) {
      slots.guestName = leadName;
    }
    if (!slots.guestPhone && leadPhone) {
      slots.guestPhone = leadPhone;
    }
    if (!slots.guestEmail && leadEmail) {
      slots.guestEmail = leadEmail;
    }

    const isNamePlaceholder = this.isPlaceholderName(slots.guestName ?? leadName);
    const isContactMissing = !(slots.guestPhone ?? leadPhone) && !(slots.guestEmail ?? leadEmail);

    let escalated = false;
    let escalationReason: string | undefined;
    let escalationType: 'sales' | 'support' | undefined;
    let crmPipelineStatus: string | undefined;
     
    let scheduleReminder: any;
     

    let provider;
    try {
      provider = await LLMProviderFactory.createProviderForUser(userId);
    } catch (err) {
      logger.error({ err }, '[HotelSalesAgent] No LLM provider available');
      return { replyText: this.fallbackReply(), escalated: true, escalationReason: 'AI provider unavailable', confidence: 0 };
    }

    const hotel = await this.loadHotelContext(userId);
    const dynamicHotelContext = await getDynamicHotelContext(userId);
    const history = await this.loadHistory(userId, conversationId, input.isSupportChat);

    // Fetch payment settings to pass to prompt
    let paymentBlock = "";
    let externalBookingMode = false;
    try {
      const paymentConfig = await getHotelPaymentConfiguration(userId);
      const provider = paymentConfig.provider;
      const methods = paymentConfig.methods;

      if (!paymentConfig.paymentMethodsEnabled) {
        externalBookingMode = true;
        paymentBlock = `
--- EXTERNAL BOOKING MODE ---
This property completes all new bookings on an owner-configured external booking page.

INSTRUCTIONS:
1. Do not call create_booking for a new stay or expose disabled payment details. send_payment_link and check_payment_status may be used only for a verified pending internal booking created before this mode was enabled.
2. Collect the guest's real name and at least one contact method, dates, guest count, room count, and selected room.
3. Verify current availability and pricing, then show the complete standard booking summary and ask for explicit confirmation.
4. Only after the guest confirms that exact summary, call continue_external_booking. Do not write, guess, copy, or modify a booking URL yourself; the delivery layer appends the approved URL.
5. Never claim a local booking, inventory hold, payment, or external confirmation exists. The external page controls final availability, price, payment, cancellation, and confirmation.
----------------------------------
`;
      } else {
        const enabledMethods: string[] = [];
        const onlineEnabled = methods.online?.enabled === true;
      
      if (onlineEnabled) {
        if (
          provider === 'razorpay'
          && paymentConfig.keyId
          && paymentConfig.keySecret
          && paymentConfig.webhookSecret
        ) {
          enabledMethods.push(`- Online Card/UPI (Razorpay Gateway): Guests can pay online after the governed booking worker confirms the booking and returns a verified payment link.`);
        } else if (provider === 'mock' && isMockPaymentAllowed()) {
          enabledMethods.push(`- Online Card/UPI (Mock Gateway): Guests can pay online only after a confirmed booking outcome returns a verified payment link.`);
        }
      }
      
      if (methods.upiQr?.enabled) {
        enabledMethods.push('- UPI Scan & Pay: enabled (retrieve approved instructions through the payment tool)');
      }
      
      if (methods.bankTransfer?.enabled) {
        enabledMethods.push('- Direct Bank Transfer: enabled (retrieve approved payment instructions through the payment tool; never expose stored account details from the model context)');
      }
      
      if (methods.customLink?.enabled) {
        enabledMethods.push('- Custom Payment Link: enabled (retrieve the approved URL through the payment tool)');
      }
      
      if (methods.manual?.enabled) {
        enabledMethods.push('- Manual / Cash / Other: enabled (human approval is required for detailed instructions)');
      }
      
      if (enabledMethods.length > 0) {
        paymentBlock = `
--- CONFIGURED PAYMENT METHODS ---
You have the following payment methods enabled for this hotel.

${enabledMethods.join('\n')}

INSTRUCTIONS:
1. After explicit guest confirmation, use create_booking to propose the governed booking action. Do not claim a booking exists or share a payment link until a confirmed effect outcome provides one.
2. IF there are multiple payment methods enabled above, you MUST politely ask the guest for their preferred mode of payment from the available options (e.g. online card/wallet payment, UPI scan & pay, or bank transfer). Do NOT assume a choice or present details for all of them at once.
3. Based on their selected mode, suggest and provide the corresponding details or payment links:
   - If they prefer online checkout (via Card/UPI gateway) or custom link, share the generated booking payment_link or custom link.
   - If they prefer UPI scan & pay or bank transfer, suggest the corresponding UPI ID/QR image URL or Bank Account details.
   - If they choose manual/cash, let them know their booking is reserved (pending payment) and our team will verify it.
----------------------------------
`;
      } else {
        paymentBlock = `
--- CONFIGURED PAYMENT METHODS ---
No payment methods have been enabled for this hotel.
INSTRUCTIONS:
1. Never auto-confirm a booking. A governed booking effect and its required approval must complete first.
2. When the guest is ready to finalize their booking, ask them in one message: "Are you sure to book the room?"
3. If they confirm, call create_booking once to propose the booking and explain that confirmation is pending. Do NOT request payment details or invent a payment link.
----------------------------------
`;
      }
      }
    } catch (err) {
      logger.error({ err }, '[HotelSalesAgent] Failed to load payment settings for prompt');
      paymentBlock = `
--- CONFIGURED PAYMENT METHODS ---
- Online Payment Link: Share a payment link only when a confirmed booking effect returns a verified URL.
----------------------------------
`;
    }

    const priorMemory = await salesIntelligence.loadMemory(leadId);
    const isReturning = (priorMemory.interactions || 0) > 0;
    if (!slots.roomTypeName && priorMemory.preferredRoomType) slots.roomTypeName = priorMemory.preferredRoomType;

    const authorizedHistory = resolveAgentConversationHistory(input.conversationHistory, history);
    const recent = authorizedHistory.slice(-6).map((m) => `${m.role === 'assistant' ? 'Agent' : 'Customer'}: ${m.content}`).join('\n');
    const nlu = input.nlu || await nluService.analyze(userId, inboundText, recent);
    
    // Slot updating from entities
    if (nlu.entities.checkIn) slots.checkIn = nlu.entities.checkIn;
    if (nlu.entities.checkOut) slots.checkOut = nlu.entities.checkOut;
    if (nlu.entities.guests) slots.guests = nlu.entities.guests;
    if (nlu.entities.rooms) slots.rooms = nlu.entities.rooms;
    if (nlu.entities.roomType && !slots.roomTypeId) slots.roomTypeName = nlu.entities.roomType;

    const sentiment = input.sentiment && input.sentiment.sentiment !== 'neutral'
      ? input.sentiment
      : { sentiment: nlu.sentiment.label, score: nlu.sentiment.score, keywords: [] as string[] };

    const intel = salesIntelligence.computeIntelligence(nlu, slots, priorMemory);
    const memory = salesIntelligence.mergeMemory(priorMemory, nlu, slots, operationalLeadName);
    const effectProposals: SupportEffectProposal[] = [];
    if (!input.isSupportChat && !input.dryRun) {
      if (leadId) {
        effectProposals.push({
          type: 'lead_memory',
          payload: { leadId, memory, score: intel.leadScore },
        });
      }
      effectProposals.push({
        type: 'conversation_state',
        payload: {
          nlu: { intent: nlu.intent, secondaryIntents: nlu.secondaryIntents, entities: nlu.entities, sentiment, urgency: nlu.urgency, needsHuman: nlu.needsHuman, summary: nlu.summary },
          leadIntelligence: intel,
        },
      });
    }
    
    logger.info({ conversationId, intent: nlu.intent, leadScore: intel.leadScore, bookingProb: intel.bookingProbability, value: intel.value, returning: isReturning }, '[HotelSalesAgent] NLU + intelligence');

    const socialProof = await hotelHistoryService.socialProofLine(userId);

    const dbAgentConfig: AgentConfigLike | null = input.agentConfig || null;

    const hardcodedPrompt = this.systemPrompt(input, slots, hotel, dynamicHotelContext, channel, isNamePlaceholder, isContactMissing, nlu, sentiment, memory, intel, isReturning, socialProof, paymentBlock);
    const guestRealName = slots.guestName ?? leadName;
    const replacementName = (guestRealName && !this.isPlaceholderName(guestRealName)) ? '[NAME_1]' : 'Guest';
    // Platform and hotel safeguards remain immutable; owner configuration is
    // appended as persona guidance by the shared prompt builder.
    const messages = buildFewShotMessages({
      agentConfig: dbAgentConfig,
      fallbackSystemPrompt: hardcodedPrompt,
      channelRules: channel === 'email'
        ? 'Return a professional email body without a subject line or Markdown.'
        : 'Return a concise customer-ready message appropriate for the active channel.',
      playbookInstruction: input.playbookDirective?.instruction,
      verifiedContext: [
        `--- VERIFIED HOTEL PROFILE ---\n${JSON.stringify(hotel)}`,
        dynamicHotelContext ? `--- VERIFIED DYNAMIC HOTEL CONTEXT ---\n${dynamicHotelContext}` : '',
        input.kbContext?.length ? `--- VERIFIED KNOWLEDGE CONTEXT ---\n${input.kbContext.join('\n\n')}` : '',
      ].filter(Boolean).join('\n\n'),
      platformInstructions: input.platformInstructions,
      conversationHistory: authorizedHistory,
      inboundText,
      guestName: replacementName,
    });

    const subAgentCtx: SubAgentContext = {
      userId,
      conversationId,
      channel,
      inboundText,
      rawMessageId: input.rawMessageId,
      messageId: input.messageId,
      nlu,
      slots,
      memory,
      intel,
      lead: {
        id: leadId,
        name: leadName,
        phone: slots.guestPhone || leadPhone,
        email: slots.guestEmail || leadEmail,
        recipientPhone: operationalRecipient,
      },
      agentConfig: input.agentConfig || null,
      businessProfileId: input.businessProfileId,
      knowledgeResult: input.contextLanes?.knowledge,
      history: authorizedHistory,
      playbookDirective: input.playbookDirective || null,
      dryRun: input.dryRun,
      executionMode: input.executionMode,
      widgetSession: input.widgetSession,
      isSupportChat: input.isSupportChat,
    };

    let replyText: string | null = null;
     
    const toolCallsExecuted: any[] = [];
    let generationMetadata: AgentResult['generationMetadata'];
    let externalBookingHandoff: ExternalBookingHandoff | undefined;
    const negotiationToolPolicy = hotelNegotiationToolPolicy(nlu.semanticRequest);
    const requireOwnerAvailabilityRead = shouldRequireOwnerAvailabilityRead({ ...input, nlu });
    const tools = this.toolsForInput(input).filter((tool) => {
      const toolName = tool.function?.name;
      if (requireOwnerAvailabilityRead && toolName !== 'check_room_availability') return false;
      const modeAllowsTool = externalBookingMode
        ? toolName !== 'create_booking'
        : toolName !== 'continue_external_booking';
      if (!modeAllowsTool) return false;
      if (input.playbookDirective?.requiredAction === toolName) return true;
      if (toolName === 'quote_or_negotiate_price') return negotiationToolPolicy.allowNegotiation;
      if (toolName === 'handle_objection') return negotiationToolPolicy.allowObjectionHandling;
      return true;
    });

    // This authenticated owner surface is a deterministic read boundary. Do
    // not depend on a provider honoring tool_choice=required: some routed
    // models occasionally return identity-intake prose instead of the offered
    // read-only tool call, producing channel-dependent results for the same
    // request.
    if (requireOwnerAvailabilityRead) {
      const args = normalizeOwnerAvailabilityReadArgs(nlu.entities, {});
      const out = await this.dispatchToSubAgent(
        'check_room_availability',
        args,
        subAgentCtx,
        ['check_room_availability'],
      );
      if (out.slotsUpdate) Object.assign(slots, out.slotsUpdate);
      if (out.escalated) {
        escalated = true;
        escalationReason = out.escalationReason;
        escalationType = out.escalationType;
      }
      if (out.crmPipelineStatus) crmPipelineStatus = out.crmPipelineStatus;
      if (out.scheduleReminder) scheduleReminder = out.scheduleReminder;
      if (out.effectProposals?.length) effectProposals.push(...out.effectProposals);
      if (out.externalBookingHandoff) externalBookingHandoff = out.externalBookingHandoff;
      toolCallsExecuted.push(this.recordToolOutcome('check_room_availability', args, out));
    }

    for (let turn = 0; turn < (requireOwnerAvailabilityRead ? 0 : MAX_TURNS); turn++) {
      const selectedModel = input.agentConfig?.modelOverride || provider.defaultModel;
      const turnTools = requireOwnerAvailabilityRead && toolCallsExecuted.length > 0
        ? []
        : this.toolsForGenerationTurn(input, tools, toolCallsExecuted.length);
      const requiresToolCall = Boolean(input.playbookDirective?.requiredAction)
        || (requireOwnerAvailabilityRead && toolCallsExecuted.length === 0);
      const resp = this.requiredToolResponse(input, turnTools, toolCallsExecuted.length) || await LLMProviderFactory.createChatCompletionWithFallback(userId, {
        model: selectedModel,
        messages,
        tools: turnTools.length > 0 ? turnTools : undefined,
        tool_choice: turnTools.length > 0 ? (requiresToolCall ? 'required' : 'auto') : undefined,
        temperature: 0.4,
        loggingContext: { userId, threadId: conversationId, purpose: 'hotel_sales_agent', service: 'HotelSalesAgent' },
       
      } as any);
      generationMetadata = { provider: resp.completion?.provider || (typeof provider.getProviderName === 'function' ? provider.getProviderName() : 'unknown'), model: resp.completion?.model || selectedModel, promptTokens: resp.usage?.promptTokens, completionTokens: resp.usage?.completionTokens, totalTokens: resp.usage?.totalTokens };

      const msg = resp.completion?.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        replyText = (resp.content || msg?.content || '').trim() || null;
        break;
      }

      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls });

      for await (const { tc, args, out, durationMs } of runSupportToolCalls(toolCalls,
        (name, args) => this.dispatchToSubAgent(name, args, subAgentCtx,
          this.toolsForGenerationTurn(input, turnTools, toolCallsExecuted.length).map(tool => tool.function?.name || '')),
        { requiredAction: input.playbookDirective?.requiredAction, normalize: (name, args) => requireOwnerAvailabilityRead && name === 'check_room_availability' ? normalizeOwnerAvailabilityReadArgs(nlu.entities, args) : args })) {
        if (out.slotsUpdate) {
          Object.assign(slots, out.slotsUpdate);
        }
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
        if (out.effectProposals?.length) {
          effectProposals.push(...out.effectProposals);
        }
        if (out.externalBookingHandoff) {
          externalBookingHandoff = out.externalBookingHandoff;
        }

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

    const latestTurnExplicitlyConfirms = /^(?:yes\b|i\s+(?:explicitly\s+)?confirm\b|confirmed\b|please\s+(?:proceed|book|reserve)\b|go\s+ahead\b)/i
      .test(inboundText.trim());
    if (!externalBookingHandoff && !latestTurnExplicitlyConfirms) {
      const availabilityOutcome = [...toolCallsExecuted].reverse().find((outcome) =>
        outcome.name === 'check_room_availability' && outcome.status === 'success' && outcome.success === true);
      const availabilityResult = availabilityOutcome?.result && typeof availabilityOutcome.result === 'object'
        ? availabilityOutcome.result as Record<string, unknown>
        : null;
      const options = Array.isArray(availabilityResult?.options)
        ? availabilityResult.options.filter((option): option is Record<string, unknown> =>
          Boolean(option) && typeof option === 'object' && !Array.isArray(option))
        : [];
      const playbookNodeId = input.playbookDirective?.nodeId;
      const isSelectionBoundary = isAvailabilitySelectionBoundary(playbookNodeId, requireOwnerAvailabilityRead);
      const availabilityArgs = availabilityOutcome?.args || {};
      const verifiedCheckIn = String(input.playbookDirective?.actionArgs?.check_in
        || availabilityArgs.check_in || slots.checkIn || '');
      const verifiedCheckOut = String(input.playbookDirective?.actionArgs?.check_out
        || availabilityArgs.check_out || slots.checkOut || '');
      const verifiedGuests = Number(input.playbookDirective?.actionArgs?.guests
        || availabilityArgs.guests || slots.guests);
      if (isSelectionBoundary && verifiedCheckIn && verifiedCheckOut && verifiedGuests > 0
        && availabilityResult?.success === true && Array.isArray(availabilityResult.options)
        && (options.length > 0 || availabilityResult.count === 0)) {
        replyText = renderVerifiedHotelAvailabilityOptions({
          checkIn: verifiedCheckIn,
          checkOut: verifiedCheckOut,
          guests: verifiedGuests,
          options: options.flatMap((option) => {
            const pricePerNight = Number(option.price_per_night);
            return typeof option.name === 'string' && Number.isFinite(pricePerNight) && pricePerNight > 0
              ? [{
                roomName: option.name,
                pricePerNight,
                currency: typeof option.currency === 'string' ? option.currency : 'INR',
              }]
              : [];
          }),
        });
      }
      const selected = options.find((option) => Number(option.room_type_id) === Number(slots.roomTypeId))
        ?? (options.length === 1 ? options[0] : undefined);
      const pricePerNight = Number(selected?.price_per_night);
      if (playbookNodeId === 'recheck-selected-room'
        && selected && slots.checkIn && slots.checkOut && slots.guests && slots.rooms
        && typeof selected.name === 'string' && Number.isFinite(pricePerNight) && pricePerNight > 0) {
        replyText = renderVerifiedHotelBookingSummary({
          roomName: selected.name,
          roomCount: Number(slots.rooms),
          guests: Number(slots.guests),
          checkIn: slots.checkIn,
          checkOut: slots.checkOut,
          pricePerNight,
          currency: typeof selected.currency === 'string' ? selected.currency : 'INR',
        });
      }
    }

    // Owner previews can show the exact successful public payment lookup.
    // Final claim verification still applies to every returned line.
    if (input.executionMode === 'advisory' && input.isSupportChat && toolCallsExecuted.length === 1) {
      const payment = toolCallsExecuted[0];
      if (payment.name === 'get_payment_methods' && payment.status === 'success' && payment.success === true
        && payment.result && typeof payment.result === 'object' && !Array.isArray(payment.result)) {
        replyText = renderVerifiedHotelPaymentMethods(payment.result) || replyText;
      }
    }
    if (!replyText) replyText = this.fallbackReply();
    if (externalBookingHandoff) {
      // The model never receives the configured URL. Delivery renders the
      // exact approved destination in a channel-specific, non-editable form.
      replyText = externalBookingHandoff.stage === 'search'
        ? 'The hotel’s live room search will be included with this message. Availability, final price, payment, and confirmation are completed on that page.'
        : 'Your room selection is ready to continue. The hotel booking page will be included with this message. Availability, final price, payment, and confirmation are completed on that page.';
    }

    // Deterministic guards
    const isLegal = (nlu.riskFactors || []).some(factor => ['legal_threat', 'regulatory_threat'].includes(factor));
    const repeatedDissatisfaction = (memory.negativeCount || 0) >= 2;
    const salesIntent = ['negotiation', 'pricing_question', 'booking_request', 'availability_inquiry'].includes(nlu.intent);
    const hardSupport = nlu.intent === 'complaint' || nlu.intent === 'refund_request' || isLegal || repeatedDissatisfaction
      || (nlu.needsHuman && !salesIntent && (sentiment.sentiment === 'negative' || nlu.intent === 'support_request'));
    const hardHuman = nlu.intent === 'speak_to_human';
    const rooms = nlu.entities.rooms || slots.rooms || 0;
    const isVip = intel.value === 'high' && intel.estimatedValue >= 75000;
    const isSalesAction = ['negotiation', 'pricing_question', 'booking_request'].includes(nlu.intent);
    const hardSales = rooms >= LARGE_GROUP_ROOMS || (isVip && isSalesAction);

    if (!escalated && (hardSupport || hardHuman)) {
      const reason = isLegal ? 'legal/escalated complaint' : repeatedDissatisfaction ? 'repeated dissatisfaction' : nlu.intent.replace(/_/g, ' ');
      escalated = true;
      escalationReason = reason;
      escalationType = 'support';
      crmPipelineStatus = 'ticket_open';
    } else if (!escalated && hardSales) {
      const reason = rooms >= LARGE_GROUP_ROOMS ? `large group booking (${rooms} rooms)` : `high-value opportunity (est. ${intel.estimatedValue})`;
      // A high-value score is an operator alert, not evidence that a human has
      // actually taken ownership. Large groups still require a hard handoff;
      // ordinary VIP opportunities remain AI-active until an operator accepts.
      const requiresTakeover = rooms >= LARGE_GROUP_ROOMS;
      escalated = requiresTakeover;
      escalationReason = requiresTakeover ? reason : undefined;
      escalationType = requiresTakeover ? 'sales' : undefined;
      crmPipelineStatus = 'negotiation';
    }

    if (!input.dryRun && !input.isSupportChat) {
      effectProposals.push({
        type: 'conversation_state',
        payload: { salesAgent: { slots, lastEscalated: escalated, escalationReason, lastIntent: nlu.intent } },
      });
    }

    return {
      replyText,
      escalated,
      escalationReason,
      escalationType,
      intent: nlu.intent,
      crmPipelineStatus,
      scheduleReminder,
      toolCallsExecuted,
      effectProposals,
      externalBookingHandoff,
      handoff: { required: escalated, type: escalationType, reason: escalationReason },
      groundingStatus: input.kbContext?.length ? 'grounded' : 'insufficient_knowledge',
      followUp: { eligible: !escalated, consent: 'unknown' },
      generationMetadata,
    };
  }

   
  private async loadState(userId: number, conversationId: number): Promise<any> {
    const rows = await db.execute(sql`
      SELECT metadata FROM outreach_conversations
      WHERE id = ${conversationId} AND user_id = ${userId}
    `);
     
    const md = (rows.rows[0] as any)?.metadata || {};
    return md.salesAgent || { slots: {} };
  }

   
  private async loadHotelContext(userId: number): Promise<HotelContext | null> {
    try {
      const rows = await db.execute(sql`
        SELECT name, city, address, phone, email, description, amenities, check_in_time, check_out_time
        FROM hotel_properties WHERE user_id = ${userId} ORDER BY id ASC LIMIT 1
      `);
       
      const r = (rows.rows as any[])[0];
      if (!r) return null;
      return {
        name: r.name,
        city: r.city,
        address: r.address || null,
        phone: r.phone || null,
        email: r.email || null,
        description: r.description || null,
        amenities: Array.isArray(r.amenities) ? r.amenities : [],
        checkInTime: r.check_in_time ? String(r.check_in_time).slice(0, 5) : null,
        checkOutTime: r.check_out_time ? String(r.check_out_time).slice(0, 5) : null,
      };
    } catch {
      return null;
    }
  }

  // Compatibility method for testing
  async dispatchTool(
    name: string | undefined,
     
    args: any,
    input: SalesAgentInput,
    slots: SlotState,
    ctx: TurnContext,
   
  ): Promise<{ result: any; escalated?: boolean; escalationReason?: string; escalationType?: 'sales' | 'support'; crmPipelineStatus?: string }> {
    const subAgentCtx: SubAgentContext = {
      userId: input.userId,
      conversationId: input.conversationId,
      channel: input.channel,
      inboundText: input.inboundText,
      rawMessageId: input.rawMessageId,
      messageId: input.messageId,
      nlu: ctx.nlu,
      slots,
      memory: ctx.memory,
      intel: ctx.intel,
      lead: {
        id: input.leadId,
        name: input.operationalIdentity ? input.operationalIdentity.leadName : input.leadName,
        phone: slots.guestPhone || (input.operationalIdentity ? input.operationalIdentity.recipientPhone : input.recipientPhone),
        email: slots.guestEmail,
        recipientPhone: input.operationalIdentity ? input.operationalIdentity.recipientPhone : input.recipientPhone,
      },
      agentConfig: input.agentConfig || null,
      businessProfileId: input.businessProfileId,
      knowledgeResult: input.contextLanes?.knowledge,
      history: [],
      playbookDirective: input.playbookDirective || null,
      dryRun: input.dryRun,
      executionMode: input.executionMode,
      isSupportChat: input.isSupportChat,
      widgetSession: input.widgetSession,
    };
    const out = await this.dispatchToSubAgent(name!, args, subAgentCtx);
    return {
      result: out.toolResults?.[0]?.result,
      escalated: out.escalated,
      escalationReason: out.escalationReason,
      escalationType: out.escalationType,
      crmPipelineStatus: out.crmPipelineStatus
    };
  }

   
  private async loadHistory(userId: number, conversationId: number, isSupportChat = false): Promise<any[]> {
    try {
      if (isSupportChat) {
        const rows = await db.execute(sql`
          SELECT scm.role AS direction, scm.content
          FROM support_chat_messages scm
          JOIN support_chat_sessions scs ON scs.id = scm.session_id
          JOIN team_members tm ON tm.id = scs.member_id
          WHERE scm.session_id = ${conversationId}
            AND tm.user_id = ${userId}
            AND scm.content IS NOT NULL AND scm.content != ''
          ORDER BY created_at DESC LIMIT 15
        `);
         
        return (rows.rows as any[])
          .reverse()
          .map((m) => ({ role: m.direction === 'assistant' ? 'assistant' : 'user', content: redactPiiWithStableTokens(String(m.content).slice(0, 1500)).redactedText }));
      }

      const rows = await db.execute(sql`
        SELECT direction, content FROM outreach_messages
        WHERE conversation_id = ${conversationId}
          AND user_id = ${userId}
          AND content IS NOT NULL AND content != ''
        ORDER BY created_at DESC LIMIT 15
      `);
       
      return (rows.rows as any[])
        .reverse()
        .map((m) => ({ role: m.direction === 'outbound' ? 'assistant' : 'user', content: redactPiiWithStableTokens(String(m.content).slice(0, 1500)).redactedText }));
    } catch {
      return [];
    }
  }

  private systemPrompt(
    input: SalesAgentInput,
    slots: SlotState,
    hotel: HotelContext | null,
    dynamicHotelContext: string,
    channel: string,
    isNamePlaceholder: boolean,
    isContactMissing: boolean,
    nlu?: NLUResult,
    sentiment?: { sentiment: string; score: number },
    memory?: CustomerMemory,
    intel?: LeadIntelligence,
    isReturning?: boolean,
    socialProof?: string,
    paymentBlock?: string
  ): string {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: DEFAULT_BUSINESS_TIMEZONE });
    const hotelBlock = hotel
      ? `Hotel Name: ${hotel.name}
${hotel.city ? `Location: ${hotel.city}` : ''}
${hotel.address ? `Address: ${hotel.address}` : ''}
${hotel.description ? `Description: ${hotel.description}` : ''}
Check-in Time: ${hotel.checkInTime || '14:00'}, Check-out Time: ${hotel.checkOutTime || '11:00'}.
Hotel amenities: ${hotel.amenities.length ? hotel.amenities.join(', ') : 'see knowledge base'}.
${dynamicHotelContext}`
      : '';

    const playbookControlsFields = Boolean(input.playbookDirective);
    const knowledgeOnly = input.playbookDirective?.nodeType === 'knowledge' || nlu?.intent === 'faq';
    const conversationGoal = knowledgeOnly
      ? 'Answer only the current factual question using authorized evidence. For comparison questions, state the relevant published limits and conditions; do not infer suitability or recommend alternatives without supporting evidence. Keep published facts separate from quantities proposed by the customer. Do not collect personal details, add contact-saving explanations, upsell, or invent a follow-up question. When a playbook is active, the shared runtime appends its outstanding question.'
      : playbookControlsFields
        ? 'Follow the active published playbook instruction. It alone selects which missing field to request and the next step. Do not add a second question, contact-collection rationale, or an unsolicited booking step.'
        : 'Help with the current request. Offer a relevant next step when useful; do not turn every message into a booking or personal-data request.';
    let validationBlock = '';
    if (isNamePlaceholder || isContactMissing) {
      validationBlock = `
--- MANDATORY CONTACT VERIFICATION RULE ---
Verified identity is required before transactional booking actions, not before answering public factual questions.
${isNamePlaceholder ? '- You do not have their real name (only a generic placeholder/identifier is known).' : ''}
${isContactMissing ? '- You do not have a contact method.' : ''}

CRITICAL constraints:
1. Do NOT call check_room_availability, create_booking, or continue_external_booking tools, and do NOT offer room availability dates, pricing, or book anything until the customer has provided their name and at least one contact method.
2. ${knowledgeOnly ? 'Answer the factual question without requesting identity or explaining why you want to save customer details.' : playbookControlsFields ? 'Let the published playbook choose when to collect missing identity fields. Never override its current question.' : 'Ask only for missing identity details when the customer is proceeding with a transactional booking action.'}
3. If they provide the details, call save_booking_details to save them.
-------------------------------------------
`;
    }
    const understanding = nlu
      ? `Understanding of the latest message (from NLU — use it, but verify with tools before acting):
- Detected intent: ${nlu.intent}${nlu.secondaryIntents.length ? ` (also: ${nlu.secondaryIntents.join(', ')})` : ''}
- Sentiment: ${sentiment?.sentiment || nlu.sentiment.label} | urgency: ${nlu.urgency}${nlu.needsHuman ? ' | likely needs a human' : ''}
- Extracted details: ${JSON.stringify(nlu.entities)}${intel ? `\n- Lead intelligence: score ${intel.leadScore}, booking probability ${intel.bookingProbability}%, value ${intel.value}, likely concern: ${intel.likelyConcern || 'none'}` : ''}
- Summary: ${nlu.summary || '(none)'}`
      : '';
    const memoryBlock = memory && (memory.interactions || isReturning)
      ? `Customer memory (from past chats — use it to personalize, but reconfirm before acting):
- ${isReturning ? 'RETURNING customer — greet them by name and reference their prior interest.' : 'New customer.'}
- Known: name=${memory.name || '?'}, preferred room=${memory.preferredRoomType || '?'}, budget=${memory.budgetPerNight ? `₹${memory.budgetPerNight}/night` : '?'}, travel reason=${memory.travelReason || '?'}, last dates=${memory.lastCheckIn || '?'}→${memory.lastCheckOut || '?'}, stage=${memory.bookingStage || 'inquiry'}.`
      : '';

    const persona = channel === 'email'
      ? `You are a top-performing hotel sales executive managing email inquiries — professional, warm, and consultative.`
      : `You are a top-performing hotel sales executive on ${channel === 'instagram' ? 'Instagram' : channel === 'facebook' ? 'Facebook' : 'WhatsApp'} — warm, consultative, and persuasive — NOT a passive FAQ bot.`;

    return `${persona} Today is ${weekday}, ${today} (resolve relative dates like "this weekend"/"next Friday" to exact YYYY-MM-DD).
${validationBlock}
${conversationGoal}

${hotelBlock}
${understanding}
${memoryBlock}
${socialProof || ''}
Customer: ${input.leadName ? '[NAME_1]' : 'Guest'}${input.leadCompany ? ` (${input.leadCompany})` : ''}.
Known booking details so far: ${JSON.stringify(slots)}.

Core rules:
- Use the tools — never invent availability, prices, or policies.
- LATEST-TURN PRIORITY: If the latest detected intent is a greeting or acknowledgement, reply briefly and offer help. Do not resurrect an old request, pending payment, or past booking unless the customer explicitly refers to it.
- PAST-DATE SAFETY: Treat dates before ${today} as historical. Never ask the customer to continue, finalize, or pay for a stay whose dates have already passed.
- SIDE-EFFECT TRUTHFULNESS: Never state that a booking, payment, refund, cancellation, or other side effect succeeded unless an authorized tool returned a successful result in this current turn.
- DATES INQUIRY: If the customer asks generally about what dates are available (without providing specific check-in/check-out dates), do NOT call the check_room_availability tool. Instead, look at the "DYNAMIC HOTEL ROOM TYPES & DAILY AVAILABILITY" block in your system prompt, find which dates have available rooms matching their guest count, list these available dates/options directly, and ask them which of these dates they prefer. Only call check_room_availability once they choose or provide specific dates.
- AMENITIES: room features come from check_room_availability's "amenities"; hotel-wide amenities are listed above; use answer_from_knowledge_base for policies/FAQs. Never say "not in the knowledge base" when amenities are available from these sources.
- AVAILABILITY BEFORE PRICING: never quote a nightly price until check_room_availability has returned a real room_type_id for the requested dates/guests (except when listing the general availability dates and base prices from the system prompt's dynamic context).
- BOOKING: collect check-in, check-out, guests, and a chosen room. Call save_booking_details as you learn each detail, and qualify_lead once you understand intent (group size, budget, urgency).
- CONFIRM BEFORE BOOKING: Before creating a booking or sending any payment link, you MUST ask the customer for confirmation by summarizing the key booking details exactly as: "Are you sure you want to book [Room Count] room(s) of this [Room Type] from [Check-In Date] to [Check-Out Date] for [Guest Count] guests at [Verified Price]?". Summarize this for all bookings and all payment methods before proceeding. Pass any perks you promised as included_perks. After they confirm, use the booking action allowed by the configured payment mode.
- BOOKING CORRECTIONS: If the customer corrects or changes any details (e.g. check-in date or guest count) during the final confirmation step, do NOT proceed. Update the slots with the new details, re-verify availability/pricing, present the updated quote, and request confirmation again.
- MID-FLOW GENERAL QUESTIONS: If the customer asks a general question (e.g., parking, pet policy) in the middle of a booking, answer it directly using the knowledge base, then immediately guide them back to the active booking flow without losing/resetting slots.
- TOOL FAILURES: If any tool call fails or returns an error, do NOT retry the tool call in a loop. Politely apologize to the customer, state there is a temporary technical issue, and offer to escalate to a human representative.
- UNKNOWN CUSTOMER GREETING: Never greet a customer by a placeholder name. Welcome them politely. An unknown name does not prevent a greeting or a factual answer; collect identity only at the applicable published playbook step or before a transactional booking action.
- PAYMENT METHOD FALLBACK: If the customer selects or requests an unsupported payment method, politely apologize, let them know it is not active, list ONLY the active enabled payment methods, and ask them to select one of the enabled methods.
- COMPLIMENTARY SERVICES: Never promise, offer, or suggest any complimentary services or items (such as free breakfast, late checkout, early check-in, free room upgrades, free airport transfers, or welcome drinks) unless they are explicitly verified and retrieved from the dynamic knowledge base context for this hotel. If the knowledge base does not explicitly confirm a service is complimentary, do NOT offer it as such.
- DISCOUNTS: Never offer or agree to any price discounts (e.g., 10% off, 20% off) unless the specific discount is explicitly defined in the retrieved knowledge base or returned by the negotiation tools. If the knowledge base does not mention an active discount, tell the guest politely that we do not offer discounts and maintain the standard rate.
- NEGOTIATION: quote/agree prices ONLY via quote_or_negotiate_price. It returns an offer_price_per_night, perks_you_can_offer, and a strategy — present the price AND weave in the perks as added value. Call it again each time they push back (it concedes gradually). NEVER agree below the floor; if it returns must_escalate=true, escalate (type "sales").

Sales-executive behaviours:
- RECOMMEND, don't just list: check_room_availability returns a recommended_room_type_id and a "why" for each room — lead with that best-fit recommendation (e.g. a Suite for a family of 4) and explain why it suits them, instead of dumping every option.
- OBJECTION HANDLING: whenever the customer hesitates, stalls, or pushes back ("too expensive", "need to think", "comparing hotels", "not sure"), call handle_objection to get a strategy + talking points (and a price deal with perks for price objections). Use it — never just give up or repeat yourself.
- USE PERKS, NOT DISCOUNTS BELOW FLOOR: when there's no price room left (at_floor=true) but the customer still hesitates, offer the perks the deal provides (free breakfast, late checkout, upgrade) instead of going lower.
- PROACTIVE SELLING: if the trip reason suggests it (anniversary, honeymoon, family, business), mention a relevant package or thoughtful add-on.
- PERSONALIZE with customer memory: greet returning guests by name and reference what they wanted before.
- Adapt tone to sentiment: empathetic + apologetic if negative; warm + efficient if positive.

When to involve a human (escalate_to_human):
- "sales": 5+ rooms / corporate / group / custom pricing / high-value opportunities.
- "support": complaints, refunds, legal threats, repeated dissatisfaction, or explicit requests for a person.

${channel === 'email'
  ? `- EMAIL FORMATTING: Output the email body in clean, professional HTML (using <p>, <br>, <b>, <i> tags). DO NOT use Markdown formatting (like **bold** or # headers). Do NOT include a subject line.
- SIGN-OFF: Sign off professionally using the sender's name.`
  : `- LENGTH: Keep replies concise and ${channel}-friendly (under ~600 characters). No markdown tables, no placeholders like [link] — include the real values returned by tools.
- MULTI-MESSAGE SPLITTING: If your response is long or contains multiple distinct thoughts/steps (e.g., greeting, answering a question, and then asking a follow-up question or sharing a link), you can separate them into multiple messages using three pipes ' ||| ' (e.g. "Hi there! ||| Here are our deluxe room options... ||| Would you like to book?"). Each section will be delivered as a separate message bubble to the customer.`
} ${paymentBlock || ''} Your final message (with no tool call) is sent verbatim to the customer.`;
  }
}

export const hotelSalesAgent = new HotelSalesAgent();
