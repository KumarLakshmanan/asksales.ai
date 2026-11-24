import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';
import { negotiationEngine } from '../../booking/NegotiationEngine.js';

export class NegotiationSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'negotiation',
    name: 'Negotiation Sub-Agent',
    description: 'Handles price quotes, discounts, and customer objections related to pricing, value, and hotel comparisons.',
    intents: ['negotiation', 'pricing_question'],
    priority: 15,
    tools: [
      {
        type: 'function',
        function: {
          name: 'quote_or_negotiate_price',
          description: 'Quote a price or negotiate a customer\'s requested nightly price for a room type. Returns a structured deal: an offer_price_per_night within approved limits PLUS optional perks (free breakfast, late check-out, upgrade…) to attach as non-price value, and a strategy hint. Call again each time the customer pushes back — the engine concedes gradually round by round and never goes below the floor. If it returns must_escalate=true, do NOT agree — escalate (type "sales").',
          parameters: {
            type: 'object',
            properties: {
              room_type_id: { type: 'integer' },
              requested_price_per_night: { type: 'number', description: 'The nightly price the customer is asking for (omit to get the best in-policy offer).' },
            },
            required: ['room_type_id'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'handle_objection',
          description: 'Get a recommended strategy + talking points to overcome a customer objection (and, for price, a concrete deal with perks). Call this whenever the customer hesitates, stalls, or pushes back so you respond like a skilled sales executive instead of giving up.',
          parameters: {
            type: 'object',
            properties: {
              objection_type: { type: 'string', enum: ['price', 'thinking_about_it', 'comparing_hotels', 'trust', 'availability', 'other'], description: 'The kind of objection the customer raised.' },
              room_type_id: { type: 'integer', description: 'The room under discussion (required for a price deal).' },
            },
            required: ['objection_type'],
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    const { userId, slots } = ctx;

    switch (name) {
      case 'quote_or_negotiate_price': {
        const requested = args.requested_price_per_night != null ? Number(args.requested_price_per_night) : undefined;
        const round = slots.negotiationRound || 0;
        const deal = await negotiationEngine.buildDeal(userId, Number(args.room_type_id), {
          round,
          requestedPrice: requested,
          travelReason: ctx.memory.travelReason,
          alreadyOffered: slots.perksOffered || [],
          checkIn: slots.checkIn,
          checkOut: slots.checkOut,
          guests: slots.guests,
          rooms: slots.rooms,
        });

        if (!deal) {
          return {
            toolResults: [{
              name,
              result: { error: 'Unknown room type.' }
            }]
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slotsUpdate: Record<string, any> = {};
        if (deal.approved) {
          slotsUpdate.agreedPricePerNight = deal.offerPrice;
          slotsUpdate.priceQuoteRoomTypeId = Number(args.room_type_id);
          slotsUpdate.priceQuotedAt = new Date().toISOString();
        }
        if (requested != null) slotsUpdate.negotiationRound = round + 1;
        if (deal.perks.length) {
          slotsUpdate.perksOffered = [...new Set([...(slots.perksOffered || []), ...deal.perks.map((p) => p.id)])];
        }

        const result = {
          success: true,
          confirmedSideEffect: false,
          approved: deal.approved,
          must_escalate: deal.mustEscalate,
          offer_price_per_night: deal.offerPrice,
          discount_pct: deal.discountPct,
          at_floor: deal.atFloor,
          floor_price: deal.floorPrice,
          base_price: deal.basePrice,
          currency: deal.currency,
          room_type: deal.roomTypeName,
          perks_you_can_offer: deal.perks.map((p) => p.label),
          strategy: deal.strategy,
        };

        const escalated = deal.mustEscalate;
        const escalationReason = escalated ? `Negotiation limit reached on ${deal.roomTypeName}` : undefined;
        const escalationType = escalated ? 'sales' as const : undefined;
        const crmPipelineStatus = escalated ? 'negotiation' : undefined;

        return {
          toolResults: [{ name, result }],
          slotsUpdate,
          escalated,
          escalationReason,
          escalationType,
          crmPipelineStatus,
        };
      }

      case 'handle_objection': {
        const objType = String(args.objection_type || 'other');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let deal: any = null;
        let escalationReason: string | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slotsUpdate: Record<string, any> = {};

        if ((objType === 'price' || objType === 'comparing_hotels') && args.room_type_id) {
          const round = slots.negotiationRound || 0;
          const d = await negotiationEngine.buildDeal(userId, Number(args.room_type_id), {
            round,
            travelReason: ctx.memory.travelReason,
            alreadyOffered: slots.perksOffered || [],
            checkIn: slots.checkIn,
            checkOut: slots.checkOut,
            guests: slots.guests,
            rooms: slots.rooms,
          });
          if (d) {
            if (d.mustEscalate) escalationReason = `Negotiation limit reached on ${d.roomTypeName}`;
            if (d.approved) {
              slotsUpdate.agreedPricePerNight = d.offerPrice;
              slotsUpdate.priceQuoteRoomTypeId = Number(args.room_type_id);
              slotsUpdate.priceQuotedAt = new Date().toISOString();
            }
            slotsUpdate.negotiationRound = round + 1;
            if (d.perks.length) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              slotsUpdate.perksOffered = [...new Set([...(slots.perksOffered || []), ...d.perks.map((p: any) => p.id)])];
            }
            deal = {
              approved: d.approved,
              must_escalate: d.mustEscalate,
              offer_price_per_night: d.offerPrice,
              discount_pct: d.discountPct,
              at_floor: d.atFloor,
              floor_price: d.floorPrice,
              currency: d.currency,
              room_type: d.roomTypeName,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              perks_you_can_offer: d.perks.map((p: any) => p.label),
            };
          }
        }

        const playbook = this.objectionPlaybook(objType);
        const result = { success: true, confirmedSideEffect: false, objection_type: objType, ...playbook, deal };

        return {
          toolResults: [{ name, result }],
          slotsUpdate,
          ...(escalationReason ? { escalated: true, escalationReason, escalationType: 'sales' as const,
            crmPipelineStatus: 'negotiation' } : {}),
        };
      }

      default:
        throw new Error(`Tool ${name} not implemented by NegotiationSubAgent`);
    }
  }

  private objectionPlaybook(type: string): { strategy: string; talking_points: string[] } {
    switch (type) {
      case 'price':
        return {
          strategy: 'Empathize, reframe around value, then offer an in-policy deal (small discount and/or perks) via the deal provided. Never just refuse.',
          talking_points: [
            'Acknowledge the budget concern genuinely.',
            'Restate only room features and benefits verified by the current availability result or published knowledge.',
            'Offer the deal: the improved price plus the listed perks as added value.',
            'Ask a soft closing question ("shall I lock this in for you?").',
          ],
        };
      case 'thinking_about_it':
        return {
          strategy: 'Clarify the concern and offer helpful next steps. Mention scarcity or a room hold only when a current authorized result verifies it.',
          talking_points: [
            'Validate that it is a good decision to consider.',
            'Discuss a room hold only if a supported tool confirms it is available; never claim a hold has been placed without a receipt.',
            'Mention limited availability for the dates if true.',
            'Ask what one thing would help them decide.',
          ],
        };
      case 'comparing_hotels':
        return {
          strategy: 'Ask what matters most (price, location, amenities) and highlight this hotel\'s strengths on that axis; back it with a deal if price-driven.',
          talking_points: [
            'Ask what they are comparing on.',
            'Highlight only differentiators verified in published knowledge or the current availability result.',
            'If price is the axis, present the deal with perks.',
          ],
        };
      case 'trust':
        return {
          strategy: 'Build confidence by explaining only the published cancellation and payment terms. If those terms are unavailable, ask the team to verify them.',
          talking_points: [
            'Quote cancellation deadlines and refund terms only when supported by current approved knowledge.',
            'Explain payment timing and security only when verified by the configured payment provider or approved knowledge.',
            'Offer specifics (reviews, policies) from the knowledge base.',
          ],
        };
      case 'availability':
        return {
          strategy: 'Offer the closest alternatives — different room type or nearby dates — rather than a dead end.',
          talking_points: [
            'Check the current availability result before saying the preferred option is unavailable.',
            'Propose an alternative room type or adjacent dates.',
            'Keep momentum toward a booking.',
          ],
        };
      default:
        return {
          strategy: 'Ask an open question to surface the real concern, then address it directly and move toward the next step.',
          talking_points: ['Clarify what is holding them back.', 'Address it specifically.', 'Suggest a concrete next step.'],
        };
    }
  }
}
export const negotiationSubAgent = new NegotiationSubAgent();
