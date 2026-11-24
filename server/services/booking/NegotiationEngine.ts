/**
 * NegotiationEngine — turns price negotiation from "accept or escalate" into a structured,
 * multi-round concession strategy with a non-price perk inventory.
 *
 * The PricingService still owns the hard floor (min_price / max_discount_pct). This engine
 * sits on top of it and decides HOW to concede:
 *   - Round 0: hold list price, optionally sweeten with a low-cost perk.
 *   - Round 1: give part of the allowed discount band.
 *   - Round 2: approach the floor + attach a perk.
 *   - Round 3+: floor price + the best perks; below the floor → escalate to a human.
 *
 * It never approves a price below the floor — that always routes to a human (mustEscalate).
 * Perks are deterministic value the agent can always offer instead of going below the floor.
 */

import { getAvailabilityProvider } from './AvailabilityProvider.js';
import { knowledgeGateway } from '../knowledge/KnowledgeGateway.js';

export interface Perk {
  id: string;
  label: string;
  tier: 'low' | 'medium' | 'high';
  appliesTo?: string[]; // travel reasons it's especially well-suited to
}

export const PERK_INVENTORY: Perk[] = [];

export interface DealContext {
  round: number;                 // how many concessions already made this conversation
  requestedPrice?: number;       // nightly price the customer asked for (optional)
  travelReason?: string | null;  // anniversary, business, family, vacation…
  alreadyOffered?: string[];     // perk ids already put on the table (don't repeat)
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  rooms?: number;
}

export interface Deal {
  approved: boolean;       // can the agent agree to offerPrice without a human?
  mustEscalate: boolean;   // customer wants below the floor → needs a human
  basePrice: number;
  floorPrice: number;      // lowest nightly price allowed without a human
  offerPrice: number;      // nightly price the agent should propose/accept
  atFloor: boolean;        // offerPrice is at the hard floor (no more price room)
  discountPct: number;     // % off base at offerPrice
  perks: Perk[];           // non-price value to attach to this offer
  currency: string;
  roomTypeName: string;
  strategy: string;        // short instruction for how to present the deal
}

export class NegotiationEngine {
  /**
   * Build a structured deal for a room type given the negotiation round + customer ask.
   * Returns null if the room type is unknown.
   */
  async buildDeal(userId: number, roomTypeId: number, ctx: DealContext): Promise<Deal | null> {
    const rt = await getAvailabilityProvider().getRoomType(userId, roomTypeId);
    if (!rt) return null;

    let base = rt.basePrice;
    let minPrice = rt.minPrice;
    let maxDiscountPct = rt.maxDiscountPct;

    if (ctx.checkIn && ctx.checkOut) {
      try {
        const options = await getAvailabilityProvider().searchAvailability({
          userId,
          checkIn: ctx.checkIn,
          checkOut: ctx.checkOut,
          guests: ctx.guests || 1,
          rooms: ctx.rooms || 1,
        });
        const match = options.find((o) => o.roomTypeId === roomTypeId);
        if (match) {
          base = match.pricePerNight;
          minPrice = match.minPrice;
          maxDiscountPct = match.maxDiscountPct;
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (err) {
        // Fallback to static values on lookup failure
      }
    }

    // Fetch discount and perk guidelines from knowledge base
    let allowedPerks: Perk[] = [];
    let allowedMaxDiscount: number | null = null;

    try {
      const kbPerks = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'hotel_policy', channel: 'internal', audience: 'internal', redactedText: 'complimentary free perk breakfast checkout checkin welcome drink room upgrade spa voucher cake airport pickup', redactedHistory: [], entities: {}, risk: 'transactional' });
      const kbDiscount = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'hotel_policy', channel: 'internal', audience: 'internal', redactedText: 'discount promotion offer percentage off rate price reduction room discount', redactedHistory: [], entities: {}, risk: 'transactional' });

      const normalizedKbPerks = kbPerks.toLowerCase();
      allowedPerks = PERK_INVENTORY.filter(p => {
        const keywords = p.id.split('_');
        return keywords.some(k => normalizedKbPerks.includes(k)) || normalizedKbPerks.includes(p.label.toLowerCase());
      });

      const normalizedKbDiscount = kbDiscount.toLowerCase();
      const discountMatches = [...normalizedKbDiscount.matchAll(/(\d+)\s*%/g)];
      const allowedPercentages = discountMatches.map(m => parseInt(m[1])).filter(p => p > 0 && p <= 100);
      if (allowedPercentages.length > 0) {
        allowedMaxDiscount = Math.max(...allowedPercentages);
      }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // Fallback to 0 if KB query fails or is not seeded
      allowedMaxDiscount = null;
    }

    // A verified KB policy may further constrain the room-type configuration.
    if (allowedMaxDiscount !== null) {
      maxDiscountPct = Math.min(maxDiscountPct, allowedMaxDiscount);
    }

    const discountFloor = Number((base * (1 - maxDiscountPct / 100)).toFixed(2));
    const floor = Math.max(minPrice, discountFloor);
    const band = Math.max(0, base - floor);
    const round = Math.max(0, Math.floor(ctx.round || 0));

    // Fraction of the discount band to give away at each round (capped at the floor).
    const FRACTIONS = [0, 0.4, 0.7, 1.0];
    const frac = FRACTIONS[Math.min(round, FRACTIONS.length - 1)];

    let offerPrice: number;
    let approved = true;
    let mustEscalate = false;

    if (ctx.requestedPrice != null) {
      if (ctx.requestedPrice >= floor) {
        // Honour their ask (never charge above base just because they offered more).
        offerPrice = Math.min(ctx.requestedPrice, base);
      } else {
        // Below the floor: counter at the floor and lean on perks. Escalate only once we've
        // already conceded a couple of times and they still push below the floor.
        offerPrice = floor;
        if (round >= 2) { approved = false; mustEscalate = true; }
      }
    } else {
      // No specific ask: stage the concession by round.
      offerPrice = Number((base - band * frac).toFixed(2));
    }

    const atFloor = offerPrice <= floor + 0.01;
    const discountPct = base > 0 ? Math.round(((base - offerPrice) / base) * 100) : 0;
    const perks = this.selectPerks(round, atFloor, ctx, allowedPerks);

    return {
      approved,
      mustEscalate,
      basePrice: base,
      floorPrice: floor,
      offerPrice,
      atFloor,
      discountPct,
      perks,
      currency: rt.currency,
      roomTypeName: rt.name,
      strategy: this.strategyFor(round, atFloor, mustEscalate, perks),
    };
  }

  /** Suggest perks for this round — more/better perks as we approach the floor. */
  selectPerks(round: number, atFloor: boolean, ctx: DealContext, allowedPerks: Perk[] = PERK_INVENTORY): Perk[] {
    const offered = new Set(ctx.alreadyOffered || []);
    const reason = (ctx.travelReason || '').toLowerCase();
    // How many perks to offer this round.
    const count = atFloor ? 2 : round >= 1 ? 1 : round === 0 ? 1 : 0;
    if (count === 0) return [];

    // Rank: travel-reason-relevant first, then by ascending cost tier (give cheap value first,
    // reserve high-cost perks for when we're at the floor and they still hesitate).
    const tierRank = { low: 0, medium: 1, high: 2 } as const;
    const pool = allowedPerks.filter((p) => !offered.has(p.id))
      // High-tier perks only when we're at the floor (no price room left).
      .filter((p) => atFloor || p.tier !== 'high');
    const ranked = [...pool].sort((a, b) => {
      const aRel = a.appliesTo?.includes(reason) ? 0 : 1;
      const bRel = b.appliesTo?.includes(reason) ? 0 : 1;
      if (aRel !== bRel) return aRel - bRel;
      return tierRank[a.tier] - tierRank[b.tier];
    });
    return ranked.slice(0, count);
  }

  private strategyFor(round: number, atFloor: boolean, mustEscalate: boolean, perks: Perk[]): string {
    if (mustEscalate) return 'They want below the lowest price you can approve — escalate to a human for special pricing rather than refusing flatly.';
    const perkText = perks.length ? ` Sweeten it with: ${perks.map((p) => p.label).join(' + ')}.` : '';
    if (atFloor) return `This is the best price you can approve.${perkText} Present it as a final, generous offer and ask to confirm.`;
    if (round === 0) return `Present the price confidently with the room's value.${perkText}`;
    return `Meet them partway with this improved price.${perkText} Keep a little room to move if they still hesitate.`;
  }
}

export const negotiationEngine = new NegotiationEngine();
