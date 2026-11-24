import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { proposalsTable } from "../proposals/schema";
export const proposalEventsTable = pgTable("proposal_events", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  proposalId: integer("proposal_id")
    .notNull()
    .references(() => proposalsTable.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull().unique(),
  kind: varchar("kind", { length: 50 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  processedAt: timestamp("processed_at"),
  lastError: text("last_error"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const proposalCatalogTable = pgTable("proposal_catalog", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull().default(""),
  currency: varchar("currency", { length: 3 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  unit: varchar("unit", { length: 50 }).notNull().default("unit"),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const proposalVersionsTable = pgTable(
  "proposal_versions",
  {
  businessProfileId: businessProfileColumn(),
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => proposalsTable.id, { onDelete: "cascade" }),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    proposalIndex: index("proposal_versions_proposal").on(
      table.userId,
      table.proposalId,
      table.id,
    ),
  }),
);
export const proposalTemplateAuditTable = pgTable("proposal_template_audit", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id"),
  adminId: integer("admin_id"),
  action: text("action").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
