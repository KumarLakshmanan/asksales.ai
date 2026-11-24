import { pgTable, serial, integer, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { adminsTable } from "../admins/schema";

export const accountDeletionRequestsTable = pgTable(
  "account_deletion_requests",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    email: varchar("email", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 255 }),
    reason: text("reason"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    adminNotes: text("admin_notes"),
    source: varchar("source", { length: 50 }).notNull().default("public_page"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    processedByAdminId: integer("processed_by_admin_id").references(() => adminsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("idx_account_deletion_requests_status").on(table.status),
    requestedAtIdx: index("idx_account_deletion_requests_requested_at").on(table.requestedAt),
    emailIdx: index("idx_account_deletion_requests_email").on(table.email),
  })
);

export type AccountDeletionRequest = typeof accountDeletionRequestsTable.$inferSelect;
export type NewAccountDeletionRequest = typeof accountDeletionRequestsTable.$inferInsert;
