/**
 * RecommendationService — picks the best-fit room from the available options so the agent
 * can RECOMMEND (like a good sales executive) instead of dumping a price list.
 *
 * Scoring blends: capacity fit (don't over-provision), budget fit, travel-reason fit
 * (suite/sea-view for anniversary/honeymoon, family-sized for families, deluxe for business),
 * and value. Returns the top pick + a human reason for each option.
 */

import type { RoomOption } from './types.js';

export interface RecommendationContext {
  guests?: number | null;
  rooms?: number | null;
  travelReason?: string | null;
  budgetPerNight?: number | null;
}

export interface RankedRoom {
  roomTypeId: number;
  name: string;
  pricePerNight: number;
  totalPrice: number;
  currency: string;
  score: number;
  reason: string;
  recommended: boolean;
}

export interface RecommendationResult {
  topPick?: RankedRoom;
  ranked: RankedRoom[];
}

export class RecommendationService {
  recommend(options: RoomOption[], ctx: RecommendationContext): RecommendationResult {
    if (!options.length) return { ranked: [] };
    const guests = ctx.guests && ctx.guests > 0 ? ctx.guests : 1;
    const reason = (ctx.travelReason || '').toLowerCase();
    const budget = ctx.budgetPerNight && ctx.budgetPerNight > 0 ? ctx.budgetPerNight : null;

    const ranked: RankedRoom[] = options.map((o) => {
      const reasons: string[] = [];
      let score = 50;

      // Capacity fit: reward a room that fits the party without huge excess capacity.
      if (o.capacity >= guests) {
        const excess = o.capacity - guests;
        score += Math.max(0, 20 - excess * 6);
        if (excess === 0) reasons.push(`fits all ${guests} guests perfectly`);
        else if (excess <= 1) reasons.push(`comfortably fits ${guests}`);
      } else {
        score -= 30; // shouldn't normally happen (query filters capacity), but guard anyway
      }

      // Budget fit.
      if (budget != null) {
        if (o.pricePerNight <= budget) { score += 18; reasons.push('within your budget'); }
        else { score -= Math.min(25, ((o.pricePerNight - budget) / budget) * 40); }
      }

      // Travel-reason fit.
      const n = o.name.toLowerCase();
      if ((reason === 'anniversary' || reason === 'honeymoon') && /(suite|sea|deluxe|premium)/.test(n)) {
        score += 16; reasons.push('a romantic, premium choice for the occasion');
      } else if (reason === 'family' && (o.capacity >= 3 || /(suite|family)/.test(n))) {
        score += 14; reasons.push('roomy enough for the whole family');
      } else if (reason === 'business' && /(deluxe|executive|business)/.test(n)) {
        score += 10; reasons.push('a comfortable pick for a work trip');
      } else if (reason === 'vacation' && /(sea|view|suite|deluxe)/.test(n)) {
        score += 8; reasons.push('great for a relaxing getaway');
      }

      // Value tie-breaker: a small nudge toward better-priced rooms.
      score += Math.max(0, 8 - o.pricePerNight / 2000);

      const reasonText = reasons.length ? this.cap(reasons.slice(0, 2).join(', ')) + '.' : `Good option for ${guests} guest${guests > 1 ? 's' : ''}.`;
      return {
        roomTypeId: o.roomTypeId,
        name: o.name,
        pricePerNight: o.pricePerNight,
        totalPrice: o.totalPrice,
        currency: o.currency,
        score: Math.round(score),
        reason: reasonText,
        recommended: false,
      };
    });

    ranked.sort((a, b) => b.score - a.score);
    if (ranked[0]) ranked[0].recommended = true;
    return { topPick: ranked[0], ranked };
  }

  private cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

export const recommendationService = new RecommendationService();
