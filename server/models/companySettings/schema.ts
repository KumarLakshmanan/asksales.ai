import { pgTable, serial, integer, text, timestamp, varchar, index, boolean, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "../users/schema";
import { businessProfileCategoriesTable, businessProfileSubcategoriesTable } from "../businessProfileCategories/schema";
import type { CrmConfiguration } from '../../../shared/crmConfiguration.js';

export const companySettings = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  // Filled by the database ownership guard for legacy creation paths.
  billingOrganizationId: integer("billing_organization_id").notNull().default(sql`app_billing_organization_id()`),
  
  // Profile Name (for multiple profiles support)
  name: varchar("name", { length: 255 }),
  
  // Profile Type - Organization or Individual
  profileType: varchar("profile_type", { length: 50 }), // 'Organization' or 'Individual'
  // Universal workspace onboarding; legacy profileType continues to describe the business model.
  workspaceType: varchar("workspace_type", { length: 50 }),
  timezone: varchar("timezone", { length: 100 }),
  applicationUses: jsonb("application_uses").$type<string[]>().default([]),
  setupGoal: text("setup_goal"),
  currentTools: text("current_tools"),
  websiteAnalysis: jsonb("website_analysis").$type<{
    url: string;
    analyzedAt: string;
    data: Record<string, unknown>;
    kbEntryId: number | null;
    summary: { pages: number; knowledgeSaved: boolean; warnings: string[] };
  }>(),
  
  // Company Details
  companyName: text("company_name"),
  industry: text("industry"),
  subIndustry: text("sub_industry"),
  website: text("website"),
  
  // Company Size
  companySize: varchar("company_size", { length: 50 }), // '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'
  annualRevenue: varchar("annual_revenue", { length: 50 }), // '$0-1M', '$1-10M', '$10-50M', '$50-100M', '$100M+'
  
  // B2C specific fields
  ownerName: text("owner_name"),
  businessName: text("business_name"),
  businessCategory: text("business_category"),
  establishedYear: varchar("established_year", { length: 10 }),
  businessHours: text("business_hours"),
  
  // Contact Information
  phone: text("phone"),
  email: text("email"),
  
  // Address
  address: text("address"),
  city: text("city"),
  state: text("state"),
  country: text("country"),
  postalCode: text("postal_code"),
  
  // Company Description & Target
  description: text("description"),
  targetMarket: text("target_market"), // Who the company sells to
  valueProposition: text("value_proposition"), // Main value offered
  
  // Social Links
  linkedinUrl: text("linkedin_url"),
  twitterUrl: text("twitter_url"),
  facebookUrl: text("facebook_url"),
  instagramUrl: text("instagram_url"),
  youtubeUrl: text("youtube_url"),
  
  // Content & Marketing Preferences
  platforms: text("platforms"), // JSON array of selected platforms
  contentFormats: text("content_formats"), // JSON array of selected content formats
  visualStyle: varchar("visual_style", { length: 100 }), // Brand visual style
  referenceAccounts: text("reference_accounts"), // Reference accounts/competitors
  businessGoals: text("business_goals"), // JSON array of business goals
  targetRegions: text("target_regions"), // JSON array of target regions
  customerType: varchar("customer_type", { length: 100 }), // Type of customers
  keyBuyerRoles: text("key_buyer_roles"), // JSON array of key buyer roles
  preferredChannels: text("preferred_channels"), // JSON array of preferred communication channels
  brandTone: varchar("brand_tone", { length: 100 }), // Brand tone/voice
  approvalMode: varchar("approval_mode", { length: 100 }), // Approval workflow mode
  restrictions: text("restrictions"), // Any business restrictions
  crmConfiguration: jsonb("crm_configuration").$type<CrmConfiguration>(),
  
  // Default profile flag
  isDefault: boolean("is_default").default(false),
  isApproved: boolean("is_approved").default(true).notNull(),
  approvedBy: integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  creationRequestKey: varchar("creation_request_key", { length: 100 }),
  creationRequestHash: varchar("creation_request_hash", { length: 64 }),
  version: integer("version").default(1).notNull(),

  // Category reference
  categoryId: integer("category_id").references(() => businessProfileCategoriesTable.id, { onDelete: 'set null' }),
  subcategoryId: integer("subcategory_id").references(() => businessProfileSubcategoriesTable.id, { onDelete: 'set null' }),
  legacyCompanyProfileId: integer("legacy_company_profile_id"),

  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  userIdIdx: index("company_settings_user_id_idx").on(table.userId),
  profileTypeIdx: index("company_settings_profile_type_idx").on(table.profileType),
  oneDefaultPerUser: uniqueIndex("company_settings_one_default_per_user_uq")
    .on(table.userId)
    .where(sql`${table.isDefault} = true`),
}));

export type CompanySettings = typeof companySettings.$inferSelect;
export type NewCompanySettings = typeof companySettings.$inferInsert;
