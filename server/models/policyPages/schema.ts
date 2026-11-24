import { pgTable, serial, varchar, text, boolean, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { adminsTable } from "../admins/schema";

export const policyPagesTable = pgTable(
  "policy_pages",
  {
    id: serial("id").primaryKey(),
    slug: varchar("slug", { length: 120 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    published: boolean("published").notNull().default(true),
    legalVersion: varchar('legal_version', { length: 40 }).notNull().default('1.0-draft'),
    approvalStatus: varchar('approval_status', { length: 20 }).notNull().default('draft'),
    counselApprovedAt: timestamp('counsel_approved_at'),
    counselApprovedBy: varchar('counsel_approved_by', { length: 255 }),
    effectiveAt: timestamp('effective_at'),
    createdByAdminId: integer("created_by_admin_id").references(() => adminsTable.id, { onDelete: "set null" }),
    updatedByAdminId: integer("updated_by_admin_id").references(() => adminsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    slugUnique: uniqueIndex("idx_policy_pages_slug_unique").on(table.slug),
    publishedIdx: index("idx_policy_pages_published").on(table.published),
  })
);

export type PolicyPage = typeof policyPagesTable.$inferSelect;
export type NewPolicyPage = typeof policyPagesTable.$inferInsert;
