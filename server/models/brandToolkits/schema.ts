import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, timestamp, serial, integer, varchar, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { usersTable } from "../users/schema";

/**
 * Brand Toolkit Schema
 * Stores brand identity, visual guidelines, voice & tone settings
 * Each user can have multiple brand toolkits for different brands/campaigns
 */
export const brandToolkitsTable = pgTable("brand_toolkits", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  
  // Brand Identity
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  tagline: text("tagline"),
  missionStatement: text("mission_statement"),
  brandValues: jsonb("brand_values").$type<string[]>(),
  brandKeywords: jsonb("brand_keywords").$type<string[]>(),
  
  // Visual Identity
  logoUrl: text("logo_url"),
  logoUrls: jsonb("logo_urls").$type<string[]>(),
  logoFileName: varchar("logo_file_name", { length: 255 }),
  logoVisibility: boolean("logo_visibility").default(true),
  primaryBrandColor: varchar("primary_brand_color", { length: 20 }),
  secondaryBrandColor: varchar("secondary_brand_color", { length: 20 }),
  accentColor: varchar("accent_color", { length: 20 }),
  primaryColors: jsonb("primary_colors").$type<string[]>(),
  secondaryColors: jsonb("secondary_colors").$type<string[]>(),
  additionalColors: jsonb("additional_colors").$type<string[]>(),
  fontFamily: varchar("font_family", { length: 100 }),
  fonts: jsonb("fonts").$type<{ heading?: string; body?: string; accent?: string }>(),
  fontFamilies: jsonb("font_families").$type<string[]>(),
  gradients: jsonb("gradients").$type<string[]>(),
  imageStyleReference: varchar("image_style_reference", { length: 100 }),
  visualInstructions: text("visual_instructions"),
  logoUsageGuidelines: text("logo_usage_guidelines"),
  imageAssets: jsonb("image_assets").$type<Array<{ url: string; originalUrl?: string; alt?:string;width?:number;height?:number;thumbnailUrl?:string;source?:"website"|"upload";originalName?:string;sizeBytes?:number }>>().default([]),
  websiteScreenshotUrl: text("website_screenshot_url"),
  
  // Voice & Tone
  voiceType: varchar("voice_type", { length: 100 }),
  customToneGuidelines: text("custom_tone_guidelines"),
  voicePersonalityTraits: jsonb("voice_personality_traits").$type<string[]>(),
  voiceDos: jsonb("voice_dos").$type<string[]>(),
  voiceDonts: jsonb("voice_donts").$type<string[]>(),
  voiceKeywords: jsonb("voice_keywords").$type<string[]>(),
  
  // Content Settings
  defaultCtas: jsonb("default_ctas").$type<string[]>(),
  defaultHashtags: jsonb("default_hashtags").$type<string[]>(),
  sampleContent: jsonb("sample_content"),
  contentPillars: jsonb("content_pillars").$type<string[]>(),
  contentFormats: jsonb("content_formats").$type<string[]>(),
  contentInstructions: text("content_instructions"),
  
  // Audience Settings
  audiencePainPoints: jsonb("audience_pain_points").$type<string[]>(),
  audienceGoals: jsonb("audience_goals").$type<string[]>(),
  audienceLanguageStyle: jsonb("audience_language_style").$type<string[]>(),
  audienceTriggers: jsonb("audience_triggers").$type<string[]>(),
  
  // Integrations
  integrationTools: jsonb("integration_tools"),
  
  // Business DNA
  website: text("website"),
  industry: varchar("industry", { length: 255 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 100 }),
  linkedinUrl: text("linkedin_url"),
  twitterUrl: text("twitter_url"),
  facebookUrl: text("facebook_url"),
  instagramUrl: text("instagram_url"),
  youtubeUrl: text("youtube_url"),

  // Status
  isDefault: boolean("is_default").default(false),
  isActive: boolean("is_active").default(true),
  isApproved: boolean("is_approved").default(false).notNull(),
  approvedBy: integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  creationRequestKey: varchar("creation_request_key", { length: 100 }),
  creationRequestHash: varchar("creation_request_hash", { length: 64 }),
  version: integer("version").default(1).notNull(),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  oneDefaultPerUser: uniqueIndex("brand_toolkits_one_default_per_user_uq")
    .on(table.businessProfileId, table.userId)
    .where(sql`${table.isDefault} = true`),
}));

// Export types
export type BrandToolkitRecord = typeof brandToolkitsTable.$inferSelect;
export type InsertBrandToolkit = typeof brandToolkitsTable.$inferInsert;

// Zod schemas for validation
export const insertBrandToolkitSchema = createInsertSchema(brandToolkitsTable);
export const selectBrandToolkitSchema = createSelectSchema(brandToolkitsTable);
