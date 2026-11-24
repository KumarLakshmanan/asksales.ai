import { businessProfileColumn } from "../businessProfileColumn.js";
import { uniqueIndex, pgTable, text, integer, timestamp, serial, varchar, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const companyProfilesTable = pgTable("company_profiles", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  
  // Basic Info
  companyName: varchar("company_name", { length: 255 }).notNull(),
  industry: varchar("industry", { length: 255 }),
  website: text("website"),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  address: text("address"),
  description: text("description"),
  employees: varchar("employees", { length: 50 }), // e.g., "50-100", "100-500"
  foundedYear: varchar("founded_year", { length: 10 }),
  
  // Company Size
  companySize: varchar("company_size", { length: 50 }), // '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'
  
  // Business Goals (JSON array)
  businessGoals: jsonb("business_goals"), // ["goal1", "goal2", ...]
  
  // Target Market Info
  primaryMarket: varchar("primary_market", { length: 100 }), // B2B, B2C, etc
  targetRegions: jsonb("target_regions"), // ["region1", "region2", ...]
  customerType: varchar("customer_type", { length: 100 }), // Enterprise, Mid-Market, etc
  keyBuyerRoles: jsonb("key_buyer_roles"), // ["CEO", "CTO", ...]
  
  // Brand Kit
  logo: text("logo"), // URL to logo image
  primaryColor: varchar("primary_color", { length: 7 }), // Hex color
  secondaryColor: varchar("secondary_color", { length: 7 }), // Hex color
  accentColor: varchar("accent_color", { length: 7 }), // Hex color
  
  // Content Info
  platforms: jsonb("platforms"), // ["Instagram", "LinkedIn", ...]
  contentFormats: jsonb("content_formats"), // ["Posts", "Videos", ...]
  visualStyle: varchar("visual_style", { length: 100 }), // Minimalist, Bold, etc
  referenceAccounts: text("reference_accounts"), // Reference URLs
  
  // Outreach Preferences
  preferredChannels: jsonb("preferred_channels"), // ["Email", "LinkedIn", ...]
  brandTone: varchar("brand_tone", { length: 100 }), // Professional, Friendly, etc
  approvalMode: varchar("approval_mode", { length: 100 }), // Auto-approve, Review, etc
  restrictions: text("restrictions"), // Any restrictions
  
  // Social Links
  socialLinks: jsonb("social_links"), // { linkedin: "", twitter: "", facebook: "" }
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  businessUserUnique: uniqueIndex("company_profiles_user_id_unique").on(table.businessProfileId, table.userId),
  userIdIdx: index("company_profiles_user_id_idx").on(table.userId),
}));

export type CompanyProfileRecord = typeof companyProfilesTable.$inferSelect;
export type InsertCompanyProfile = typeof companyProfilesTable.$inferInsert;
