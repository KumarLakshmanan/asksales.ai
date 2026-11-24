import { pgTable, serial, integer, varchar, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const userConsentsTable = pgTable(
  "user_consents",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    consentType: varchar("consent_type", { length: 50 }).notNull(),
    granted: boolean("granted").notNull(),
    reason: text("reason"),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("user_consents_user_id_idx").on(table.userId),
    typeGrantedIdx: index("user_consents_type_granted_idx").on(table.consentType, table.granted),
  })
);

export type UserConsent = typeof userConsentsTable.$inferSelect;
export type NewUserConsent = typeof userConsentsTable.$inferInsert;
