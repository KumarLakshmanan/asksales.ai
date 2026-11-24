/**
 * Credit Pricing Functions
 * CRUD for credit pricing + seeding defaults
 */

import { eq, asc } from "drizzle-orm";
import { db } from "../db.js";
import { creditPricingTable, type CreditPricingRecord, type InsertCreditPricing } from "./schema.js";
import { pricingAuditTable } from '../pricingAudit/schema.js';
import { pricingAuditValues } from '../pricingAudit/functions.js';

// Default pricing configuration
// Note: API usage pricing (api_openai, api_openrouter, api_apify, api_gemini, api_zerobounce) 
// has been removed because these are now calculated based on actual API cost from the providers
const DEFAULT_PRICING: InsertCreditPricing[] = [
  // Recharge rate
  { eventKey: "recharge_rate", name: "Credits per ₹1", description: "Number of credits given per 1 INR recharge", category: "recharge", creditsPerUnit: "10", unitLabel: "per ₹1", sortOrder: 0 },
  // Usage conversion rate (kept apart from the purchase rate so recharge promotions do not reprice AI usage)
  { eventKey: "usage_rate", name: "Credits per ₹1 of AI usage", description: "Credits charged for each ₹1 of measured AI and provider cost (after margin)", category: "recharge", creditsPerUnit: "10", unitLabel: "per ₹1 of usage", sortOrder: 1 },
  
  // Lead events
  { eventKey: "lead_generation", name: "Lead Generation", description: "Credits per lead generated/scraped", category: "lead", creditsPerUnit: "2", unitLabel: "per lead", sortOrder: 10 },
  { eventKey: "lead_enrichment", name: "Lead Enrichment", description: "Credits per lead enrichment", category: "lead", creditsPerUnit: "3", unitLabel: "per lead", sortOrder: 11 },
  { eventKey: "lead_scoring", name: "Lead Scoring", description: "Credits per lead scored", category: "lead", creditsPerUnit: "1", unitLabel: "per lead", sortOrder: 12 },
  
  // Content generation credits removed — content generation cost is covered by underlying API usage
  // (OpenAI/Gemini token costs are already deducted as api_openai/api_gemini events)
  
  // Outreach
  { eventKey: "outreach_email", name: "Email Outreach", description: "Credits per outreach email sent", category: "outreach", creditsPerUnit: "2", unitLabel: "per email", sortOrder: 30 },
  { eventKey: "outreach_sms", name: "SMS Outreach", description: "Credits per SMS sent", category: "outreach", creditsPerUnit: "3", unitLabel: "per SMS", sortOrder: 31 },
  { eventKey: "outreach_whatsapp", name: "WhatsApp Outreach", description: "Credits per WhatsApp message sent", category: "outreach", creditsPerUnit: "3", unitLabel: "per message", sortOrder: 32 },
  { eventKey: "outreach_instagram", name: "Instagram Outreach", description: "Credits per Instagram DM sent", category: "outreach", creditsPerUnit: "3", unitLabel: "per DM", sortOrder: 33, isActive: false },
  { eventKey: "outreach_facebook", name: "Facebook Outreach", description: "Credits per Facebook message sent", category: "outreach", creditsPerUnit: "3", unitLabel: "per message", sortOrder: 34, isActive: false },
  { eventKey: "outreach_linkedin", name: "LinkedIn Outreach", description: "Credits per LinkedIn message sent", category: "outreach", creditsPerUnit: "3", unitLabel: "per message", sortOrder: 35, isActive: false },
  { eventKey: "outreach_twitter", name: "X (Twitter) Outreach", description: "Credits per X (Twitter) message sent", category: "outreach", creditsPerUnit: "3", unitLabel: "per message", sortOrder: 36, isActive: false },
  
  // Performance marketing
  { eventKey: "campaign_creation", name: "Campaign Creation", description: "Credits per campaign created", category: "marketing", creditsPerUnit: "10", unitLabel: "per campaign", sortOrder: 50 },
  { eventKey: "ad_creation", name: "Ad Creation", description: "Credits per ad created", category: "marketing", creditsPerUnit: "5", unitLabel: "per ad", sortOrder: 51 },
  
  // Knowledge base
  { eventKey: "knowledge_base_upload", name: "Knowledge Base Upload", description: "Credits per knowledge base document uploaded", category: "platform", creditsPerUnit: "2", unitLabel: "per document", sortOrder: 60 },
  { eventKey: "knowledge_base_item", name: "Knowledge Base Item", description: "Credits per knowledge base Q&A item added", category: "platform", creditsPerUnit: "1", unitLabel: "per item", sortOrder: 61, isActive: false },
  
  // ICP generation
  { eventKey: "icp_generation", name: "ICP Generation", description: "Credits per ICP profile generated", category: "platform", creditsPerUnit: "5", unitLabel: "per ICP", sortOrder: 70, isActive: false },

  // AI assistant training
  { eventKey: "ai_demo_parse", name: "AI Demo Parsing", description: "Credits per AI training demo parsed (minimum 10)", category: "platform", creditsPerUnit: "10", unitLabel: "per demo", sortOrder: 80 },
];

// Event keys that are priced elsewhere (measured provider cost, api_pricing,
// or an explicit amount at the call site), so a missing row is expected.
const NON_FIXED_EVENT_PREFIXES = ['api_', 'ai_visibility_'];
const reportedMissingPricing = new Set<string>();

/** Tell administrators once per process that an action ran with no price configured. */
function reportMissingPricing(eventKey: string): void {
  if (reportedMissingPricing.has(eventKey) || NON_FIXED_EVENT_PREFIXES.some(prefix => eventKey.startsWith(prefix))) return;
  reportedMissingPricing.add(eventKey);
  void import('../adminNotifications/functions.js').then(({ notifyAllAdmins }) => notifyAllAdmins({
    title: `No credit price for "${eventKey}"`,
    message: `The action "${eventKey}" ran with no credit price configured, so it was not charged. Add a price on the Credit Pricing page (use "Seed defaults" to create missing rows).`,
    type: 'warning',
    category: 'pricing',
  })).catch(() => { reportedMissingPricing.delete(eventKey); });
}

// Seed default pricing (only inserts if not exists)
export async function seedDefaultPricing(adminId?: number): Promise<void> {
  await db.transaction(async (tx: typeof db) => {
    for (const pricing of DEFAULT_PRICING) {
      const [existing] = await tx
        .select()
        .from(creditPricingTable)
        .where(eq(creditPricingTable.eventKey, pricing.eventKey));
      if (!existing) {
        const [created] = await tx.insert(creditPricingTable).values(pricing).returning();
        await tx.insert(pricingAuditTable).values(pricingAuditValues({
          domain: 'credit_pricing',
          recordId: created.id,
          pricingKey: created.eventKey,
          action: 'seed',
          adminId,
          afterValue: created,
        }));
      }
    }
  });
}

// Get all pricing configurations
export async function getAllPricing(): Promise<CreditPricingRecord[]> {
  return await db
    .select()
    .from(creditPricingTable)
    .orderBy(asc(creditPricingTable.sortOrder));
}

// Get pricing by event key
export async function getPricingByKey(eventKey: string): Promise<CreditPricingRecord | undefined> {
  const [pricing] = await db
    .select()
    .from(creditPricingTable)
    .where(eq(creditPricingTable.eventKey, eventKey));
  return pricing;
}

// Get credit cost for an event
export async function getCreditCost(eventKey: string): Promise<number> {
  const pricing = await getPricingByKey(eventKey);
  if (!pricing) { reportMissingPricing(eventKey); return 0; }
  if (!pricing.isActive) return 0;
  return parseFloat(pricing.creditsPerUnit as string);
}

// Get recharge rate: credits a customer receives per ₹1 paid
export async function getRechargeRate(): Promise<number> {
  const pricing = await getPricingByKey("recharge_rate");
  // A configured 0 stays 0 so recharge refuses with "pricing unavailable".
  return pricing ? parseFloat(pricing.creditsPerUnit as string) : 10; // Default 10 credits per ₹1
}

/**
 * Credits charged per ₹1 of measured provider cost (after margin). Falls back to
 * the recharge rate when no separate usage rate is configured, which keeps the
 * historical behaviour for deployments that have not split the two.
 */
export async function getUsageRate(): Promise<number> {
  const pricing = await getPricingByKey("usage_rate");
  const rate = pricing?.isActive ? Number(pricing.creditsPerUnit) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : getRechargeRate();
}

// Update pricing
export async function updatePricing(id: number, data: Partial<InsertCreditPricing>, adminId?: number): Promise<CreditPricingRecord | undefined> {
  return db.transaction(async (tx: typeof db) => {
    const [before] = await tx.select().from(creditPricingTable).where(eq(creditPricingTable.id, id)).limit(1);
    if (!before) return undefined;
    const [updated] = await tx
      .update(creditPricingTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(creditPricingTable.id, id))
      .returning();
    await tx.insert(pricingAuditTable).values(pricingAuditValues({
      domain: 'credit_pricing', recordId: id, pricingKey: before.eventKey, action: 'update', adminId,
      beforeValue: before, afterValue: updated,
    }));
    return updated;
  });
}

// Bulk update pricing (wrapped in a transaction for atomicity)
export async function bulkUpdatePricing(updates: { id: number; creditsPerUnit: string; isActive?: boolean }[], adminId?: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    for (const update of updates) {
      const [before] = await tx.select().from(creditPricingTable).where(eq(creditPricingTable.id, update.id)).limit(1);
      if (!before) throw new Error(`Pricing record ${update.id} was not found`);
      const changed = await tx
        .update(creditPricingTable)
        .set({
          creditsPerUnit: update.creditsPerUnit,
          ...(update.isActive !== undefined ? { isActive: update.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(creditPricingTable.id, update.id))
        .returning();
      if (changed.length !== 1) throw new Error(`Pricing record ${update.id} was not found`);
      await tx.insert(pricingAuditTable).values(pricingAuditValues({
        domain: 'credit_pricing', recordId: update.id, pricingKey: before.eventKey, action: 'update', adminId,
        beforeValue: before, afterValue: changed[0],
      }));
    }
  });
}
