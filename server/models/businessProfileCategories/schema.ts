import { pgTable, serial, varchar, text, boolean, integer, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";

export const businessProfileCategoriesTable = pgTable("business_profile_categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  description: text("description"),
  icon: varchar("icon", { length: 100 }),
  color: varchar("color", { length: 50 }),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),

  defaultFollowUpDays: integer("default_follow_up_days").default(7),
  defaultLeadPriority: varchar("default_lead_priority", { length: 50 }).default("normal"),
  autoAssignSupport: boolean("auto_assign_support").default(false),
  supportAiInstructions: text("support_ai_instructions"),
  cmsTemplateInstructions: text("cms_template_instructions"),
  customFields: jsonb("custom_fields").default([]),
  settings: jsonb("settings").default({}),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  slugIdx: index("idx_bpc_slug").on(table.slug),
  activeIdx: index("idx_bpc_active").on(table.isActive),
}));

export const businessProfileSubcategoriesTable = pgTable("business_profile_subcategories", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id").notNull().references(() => businessProfileCategoriesTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),

  followUpDays: integer("follow_up_days"),
  leadReminderDays: integer("lead_reminder_days").default(3),
  leadPriority: varchar("lead_priority", { length: 50 }),
  autoActions: jsonb("auto_actions").default([]),
  settings: jsonb("settings").default({}),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  categoryIdx: index("idx_bpsc_category").on(table.categoryId),
  categorySlugUnique: unique("bpsc_category_slug_unique").on(table.categoryId, table.slug),
}));

export type BusinessProfileCategory = typeof businessProfileCategoriesTable.$inferSelect;
export type NewBusinessProfileCategory = typeof businessProfileCategoriesTable.$inferInsert;
export type BusinessProfileSubcategory = typeof businessProfileSubcategoriesTable.$inferSelect;
export type NewBusinessProfileSubcategory = typeof businessProfileSubcategoriesTable.$inferInsert;
