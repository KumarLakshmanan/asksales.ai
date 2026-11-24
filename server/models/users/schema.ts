import { pgTable, text, serial, integer, timestamp, boolean, varchar, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  password: text("password"),
  googleSub: varchar("google_sub", { length: 255 }).unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).default("user").notNull(),
  isVerified: boolean("is_verified").default(false).notNull(),
  isSetupComplete: boolean("is_setup_complete").default(false).notNull(),
  isApproved: boolean("is_approved").default(false).notNull(),
  verificationToken: text("verification_token"),
  verificationTokenExpiry: timestamp("verification_token_expiry"),
  resetPasswordToken: text("reset_password_token"),
  resetPasswordTokenExpiry: timestamp("reset_password_token_expiry"),
  // Profile fields
  avatar: text("avatar"),
  bio: text("bio"),
  phone: varchar("phone", { length: 50 }),
  timezone: varchar("timezone", { length: 100 }).default("Asia/Kolkata"),
  notificationPreferences: jsonb("notification_preferences").$type<{
    emailNotifications: boolean;
    leadAlerts: boolean;
    campaignUpdates: boolean;
    weeklyReports: boolean;
  }>().default({
    emailNotifications: true,
    leadAlerts: true,
    campaignUpdates: true,
    weeklyReports: false,
  }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Phase 5.14 / MODEL-009: account security columns
  lastLoginAt: timestamp("last_login_at"),
  failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
  lockedUntil: timestamp("locked_until"),
  passwordChangedAt: timestamp("password_changed_at"),
  webhookTokenNonce: text("webhook_token_nonce"),
  deletedAt: timestamp("deleted_at"),
}, (table) => ({
  // Phase 3.5: token lookup indexes for auth flows
  verificationTokenIdx: index("users_verification_token_idx").on(table.verificationToken),
  resetPasswordTokenIdx: index("users_reset_password_token_idx").on(table.resetPasswordToken),
  // Phase 5.14: security column indexes
  deletedAtIdx: index("users_deleted_at_idx").on(table.deletedAt),
  lockedUntilIdx: index("users_locked_until_idx").on(table.lockedUntil),
}));

export const insertUserSchema = createInsertSchema(usersTable);
export const selectUserSchema = createSelectSchema(usersTable);

export type UserRecord = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
