import {
  bigint,
  bigserial,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businessProfileColumn } from "../businessProfileColumn.js";
import { usersTable } from "../users/schema.js";
import { chatThreadsTable } from "../chatThreads/schema.js";
import { outreachCampaignsTable } from "../outreachCampaigns/schema.js";

export const campaignManualSequencesTable = pgTable(
  "campaign_manual_sequences",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    businessProfileId: businessProfileColumn(),
    chatThreadId: integer("chat_thread_id").references(
      () => chatThreadsTable.id,
    ),
    outreachCampaignId: integer("outreach_campaign_id").references(
      () => outreachCampaignsTable.id,
    ),
    channel: text("channel").notNull(),
    version: integer("version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "campaign_manual_sequences_campaign_check",
      sql`num_nonnulls(${table.chatThreadId},${table.outreachCampaignId})=1`,
    ),
    uniqueIndex("campaign_manual_thread_channel")
      .on(table.businessProfileId, table.chatThreadId, table.channel)
      .where(sql`${table.chatThreadId} IS NOT NULL`),
    uniqueIndex("campaign_manual_outreach_channel")
      .on(table.businessProfileId, table.outreachCampaignId, table.channel)
      .where(sql`${table.outreachCampaignId} IS NOT NULL`),
  ],
);
export const campaignManualSequenceRevisionsTable = pgTable(
  "campaign_manual_sequence_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    businessProfileId: businessProfileColumn(),
    sequenceId: bigint("sequence_id", { mode: "number" })
      .notNull()
      .references(() => campaignManualSequencesTable.id),
    version: integer("version").notNull(),
    configuration: jsonb("configuration").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("campaign_manual_sequence_revisions_sequence_id_version_key").on(
      table.sequenceId,
      table.version,
    ),
  ],
);
export const campaignManualReviewsTable = pgTable(
  "campaign_manual_reviews",
  {
    id: uuid("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    businessProfileId: businessProfileColumn(),
    sequenceId: bigint("sequence_id", { mode: "number" })
      .notNull()
      .references(() => campaignManualSequencesTable.id),
    sequenceVersion: integer("sequence_version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sequenceId, table.sequenceVersion],
      foreignColumns: [
        campaignManualSequenceRevisionsTable.sequenceId,
        campaignManualSequenceRevisionsTable.version,
      ],
    }),
  ],
);
