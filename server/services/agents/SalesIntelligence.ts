/**
 * SalesIntelligence — cross-conversation customer memory + lead intelligence for the
 * WhatsApp Sales Agent. Turns the agent from "answer questions" into "remember the
 * customer, score the opportunity, and hand humans a crisp summary".
 *
 * Memory lives on leads.sales_memory (durable per customer/phone). Lead intelligence
 * (score, booking probability, urgency, value, likely concern, stage) is recomputed each
 * turn from NLU + collected slots + memory.
 */

import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import type { NLUResult } from './NLUService.js';

export interface CustomerMemory {
  name?: string | null;
  budgetPerNight?: number | null;
  preferredRoomType?: string | null;
  travelReason?: string | null;     // vacation, business, anniversary, family, event…
  bookingStage?: string;            // inquiry | collecting | negotiation | ready | payment | confirmed
  lastCheckIn?: string | null;
  lastCheckOut?: string | null;
  lastGuests?: number | null;
  lastRooms?: number | null;
  concerns?: string[];              // e.g. ["price","decision"]
  negativeCount?: number;           // repeated dissatisfaction tracker
  interactions?: number;
  lastSeenAt?: string;
}

export interface LeadIntelligence {
  leadScore: number;            // 0-100
  bookingProbability: number;   // 0-100
  urgency: 'low' | 'medium' | 'high';
  value: 'low' | 'medium' | 'high';
  estimatedValue: number;       // currency amount of the prospective booking
  likelyConcern: string | null; // price | decision | availability | trust | none
}

interface SlotLike {
  checkIn?: string; checkOut?: string; guests?: number; rooms?: number;
  roomTypeId?: number; roomTypeName?: string; agreedPricePerNight?: number;
}

export class SalesIntelligence {
  async loadMemory(leadId?: number | null): Promise<CustomerMemory> {
    if (!leadId) return {};
    try {
      const r = await db.execute(sql`SELECT sales_memory FROM leads WHERE id = ${leadId}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((r.rows[0] as any)?.sales_memory as CustomerMemory) || {};
    } catch { return {}; }
  }

  async saveMemory(leadId: number | null | undefined, mem: CustomerMemory): Promise<void> {
    if (!leadId) return;
    try {
      await db.execute(sql`UPDATE leads SET sales_memory = ${JSON.stringify(mem)}::jsonb, updated_at = NOW() WHERE id = ${leadId}`);
    } catch (err) { logger.warn({ err, leadId }, '[SalesIntelligence] saveMemory failed'); }
  }

  /** Merge what we learned this turn into durable memory. */
  mergeMemory(mem: CustomerMemory, nlu: NLUResult, slots: SlotLike, leadName?: string | null): CustomerMemory {
    const e = nlu.entities;
    const m: CustomerMemory = { ...mem };
    if (leadName && !m.name) m.name = leadName;
    if (e.budgetPerNight) m.budgetPerNight = e.budgetPerNight;
    if (slots.roomTypeName || e.roomType) m.preferredRoomType = slots.roomTypeName || e.roomType || m.preferredRoomType;
    if (slots.checkIn) m.lastCheckIn = slots.checkIn;
    if (slots.checkOut) m.lastCheckOut = slots.checkOut;
    if (slots.guests) m.lastGuests = slots.guests;
    if (slots.rooms) m.lastRooms = slots.rooms;
    // travel reason hints from intent/summary
    const text = `${nlu.summary || ''}`.toLowerCase();
    const reason = /anniversary/.test(text) ? 'anniversary'
      : /honeymoon/.test(text) ? 'honeymoon'
      : /business|corporate|offsite|conference/.test(text) ? 'business'
      : /family/.test(text) ? 'family'
      : /vacation|holiday|getaway/.test(text) ? 'vacation' : m.travelReason || null;
    if (reason) m.travelReason = reason;
    m.bookingStage = this.stage(nlu, slots);
    // concerns
    const concerns = new Set(m.concerns || []);
    if (nlu.intent === 'negotiation' || nlu.intent === 'pricing_question') concerns.add('price');
    if (/family|spouse|partner|discuss|think about|get back/.test(text)) concerns.add('decision');
    m.concerns = [...concerns];
    // Only genuine service dissatisfaction counts toward "repeated dissatisfaction" — NOT sales
    // negativity like price objections (those are a buying signal, not a complaint).
    const salesIntent = ['negotiation', 'pricing_question', 'booking_request', 'availability_inquiry'].includes(nlu.intent);
    const isServiceComplaint = ['complaint', 'refund_request', 'support_request'].includes(nlu.intent) || (nlu.sentiment.label === 'negative' && !salesIntent);
    if (isServiceComplaint) m.negativeCount = (m.negativeCount || 0) + 1;
    m.interactions = (m.interactions || 0) + 1;
    m.lastSeenAt = new Date().toISOString();
    return m;
  }

  private stage(nlu: NLUResult, slots: SlotLike): string {
    const hasAll = !!(slots.checkIn && slots.checkOut && slots.guests && slots.roomTypeId);
    if (nlu.intent === 'cancel_booking') return 'cancelling';
    if (slots.agreedPricePerNight && hasAll) return 'ready';
    if (nlu.intent === 'negotiation') return 'negotiation';
    if (nlu.intent === 'booking_request' && hasAll) return 'ready';
    if (slots.checkIn || nlu.intent === 'availability_inquiry') return 'collecting';
    return 'inquiry';
  }

  /** Recompute the lead-intelligence snapshot from this turn's signals. */
  computeIntelligence(nlu: NLUResult, slots: SlotLike, mem: CustomerMemory): LeadIntelligence {
    const intent = nlu.intent;
    const rooms = slots.rooms || nlu.entities.rooms || mem.lastRooms || 1;
    const nights = this.nights(slots.checkIn, slots.checkOut) || 1;
    const nightly = slots.agreedPricePerNight || nlu.entities.budgetPerNight || mem.budgetPerNight || 0;
    const estimatedValue = nightly * rooms * nights;

    // lead score (0-100)
    let score = 0;
    score += intent === 'booking_request' ? 40 : intent === 'negotiation' ? 35 : intent === 'pricing_question' ? 25 : intent === 'availability_inquiry' ? 20 : 5;
    score += nlu.urgency === 'high' ? 25 : nlu.urgency === 'medium' ? 12 : 0;
    score += rooms >= 10 ? 25 : rooms >= 5 ? 18 : rooms >= 2 ? 8 : 4;
    if (nlu.entities.budgetPerNight || mem.budgetPerNight) score += 6;
    score = Math.min(100, score);

    // booking probability (0-100)
    let prob = intent === 'booking_request' ? 60 : intent === 'negotiation' ? 55 : intent === 'pricing_question' ? 42 : intent === 'availability_inquiry' ? 35 : intent === 'faq' ? 12 : 8;
    const slotsFilled = [slots.checkIn, slots.checkOut, slots.guests, slots.roomTypeId].filter(Boolean).length;
    prob += slotsFilled * 6;            // up to +24 when fully collected
    prob += nlu.sentiment.label === 'positive' ? 10 : nlu.sentiment.label === 'negative' ? -18 : 0;
    prob += nlu.urgency === 'high' ? 10 : 0;
    if (mem.bookingStage === 'ready' || mem.bookingStage === 'payment') prob += 12;
    prob = Math.max(0, Math.min(100, prob));

    // value bucket
    const value: LeadIntelligence['value'] = (rooms >= 5 || estimatedValue >= 50000) ? 'high' : (rooms >= 2 || estimatedValue >= 15000) ? 'medium' : 'low';

    // likely concern
    const likelyConcern = (intent === 'negotiation' || intent === 'pricing_question') ? 'price'
      : (mem.concerns || []).includes('decision') ? 'decision'
      : intent === 'availability_inquiry' ? 'availability'
      : null;

    return { leadScore: score, bookingProbability: prob, urgency: nlu.urgency, value, estimatedValue, likelyConcern };
  }

  /** Crisp human-facing summary for escalation tickets/notifications. */
  buildLeadSummary(opts: {
    name?: string | null; phone?: string | null; slots: SlotLike; mem: CustomerMemory;
    intel: LeadIntelligence; currency?: string; reason: string; suggestedAction: string;
  }): string {
    const { slots, mem, intel } = opts;
    const dates = slots.checkIn && slots.checkOut ? `${slots.checkIn} → ${slots.checkOut} (${this.nights(slots.checkIn, slots.checkOut)}n)` : (mem.lastCheckIn ? `${mem.lastCheckIn} → ${mem.lastCheckOut || '?'}` : 'not provided');
    const cur = opts.currency || 'INR';
    const budget = mem.budgetPerNight ? `${cur} ${mem.budgetPerNight}/night` : 'not stated';
    return [
      'Lead Summary',
      `Customer: ${opts.name || mem.name || 'WhatsApp guest'}${opts.phone ? ` (${opts.phone})` : ''}`,
      `Dates: ${dates}`,
      `Guests / Rooms: ${slots.guests || mem.lastGuests || '?'} / ${slots.rooms || mem.lastRooms || 1}`,
      `Room: ${slots.roomTypeName || mem.preferredRoomType || 'undecided'}`,
      `Travel reason: ${mem.travelReason || 'unknown'}`,
      `Budget: ${budget}`,
      `Lead score: ${intel.leadScore} | Booking probability: ${intel.bookingProbability}% | Urgency: ${intel.urgency} | Value: ${intel.value} (est. ${cur} ${intel.estimatedValue || 0})`,
      `Likely concern: ${intel.likelyConcern || 'none'}`,
      `Stage: ${mem.bookingStage || 'inquiry'}${(mem.negativeCount || 0) >= 2 ? ' | repeated dissatisfaction' : ''}`,
      `Reason for escalation: ${opts.reason}`,
      `Suggested action: ${opts.suggestedAction}`,
    ].join('\n');
  }

  private nights(ci?: string, co?: string): number {
    if (!ci || !co) return 0;
    const a = new Date(ci + 'T00:00:00Z').getTime(); const b = new Date(co + 'T00:00:00Z').getTime();
    return Math.max(0, Math.round((b - a) / 864e5));
  }
}

export const salesIntelligence = new SalesIntelligence();
