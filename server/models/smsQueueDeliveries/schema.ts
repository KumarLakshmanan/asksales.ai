import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema.js";
import { companySettings } from "../companySettings/schema.js";
import { businessProfileColumn } from "../businessProfileColumn.js";
export const smsQueueDeliveriesTable = pgTable(
  "sms_queue_deliveries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    businessProfileId: businessProfileColumn()
      .notNull()
      .references(() => companySettings.id),
    businessActorUserId: integer("business_actor_user_id").notNull(),
    billingActorUserId: integer("billing_actor_user_id").notNull(),
    billingOrganizationId: integer("billing_organization_id").notNull(),
    jobId: text("job_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state").notNull().default("pending"),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    reservationReference: text("reservation_reference"),
    reservationId: integer("reservation_id"),
    providerMessageId: text("provider_message_id"),
    activityMessageId: integer("activity_message_id"),
    activityConfirmedAt: timestamp("activity_confirmed_at", {
      withTimezone: true,
    }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    intent: uniqueIndex("sms_queue_deliveries_intent").on(
      table.businessProfileId,
      table.userId,
      table.jobId,
    ),
  }),
);
