import { db } from "../db";
import { companySettings, type CompanySettings } from "./schema";
import { eq, desc, and } from "drizzle-orm";
import { currentBusinessScope } from '../../tenancy/businessContext.js';

export async function getCompanySettingsByUserId(userId: number): Promise<CompanySettings | undefined> {
  const scope = currentBusinessScope();
  // Order by isDefault DESC so the default profile is returned first
  const [settings] = await db.select().from(companySettings)
    .where(and(eq(companySettings.userId, userId), scope ? eq(companySettings.id, scope.businessProfileId) : undefined))
    .orderBy(desc(companySettings.isDefault), desc(companySettings.updatedAt));
  return settings;
}

export async function getCompanySettingsById(id: number): Promise<CompanySettings | undefined> {
  const scope = currentBusinessScope();
  if (scope && id !== scope.businessProfileId) return undefined;
  const [settings] = await db.select().from(companySettings).where(eq(companySettings.id, id));
  return settings;
}

function parseStoredList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Canonical, normalized business context used by agents and personalization.
 * `company_settings`/business profiles is the only authoritative write model.
 */
export async function getBusinessProfileContextByUserId(userId: number) {
  const profile = await getCompanySettingsByUserId(userId);
  if (!profile) return undefined;
  return {
    id: profile.id,
    companyName: profile.companyName || profile.businessName || profile.name || '',
    workspaceType: profile.workspaceType || undefined,
    timezone: profile.timezone || undefined,
    applicationUses: profile.applicationUses || [],
    setupGoal: profile.setupGoal || undefined,
    currentTools: profile.currentTools || undefined,
    industry: profile.industry || undefined,
    website: profile.website || undefined,
    description: profile.description || undefined,
    employees: profile.companySize || undefined,
    companySize: profile.companySize || undefined,
    primaryMarket: profile.targetMarket || undefined,
    targetMarket: profile.targetMarket || undefined,
    targetRegions: parseStoredList(profile.targetRegions),
    customerType: profile.customerType || undefined,
    keyBuyerRoles: parseStoredList(profile.keyBuyerRoles),
    businessGoals: parseStoredList(profile.businessGoals),
    preferredChannels: parseStoredList(profile.preferredChannels),
    brandTone: profile.brandTone || undefined,
    platforms: parseStoredList(profile.platforms),
    valueProposition: profile.valueProposition || undefined,
  };
}
