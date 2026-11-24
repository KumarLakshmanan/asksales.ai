import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { adminsTable } from '../admins/schema.js';
import { usersTable } from '../users/schema.js';

export const platformSettingsTable = pgTable('platform_settings', {
  id: integer('id').primaryKey(),
  maintenanceEnabled: boolean('maintenance_enabled').notNull().default(false),
  maintenanceMessage: text('maintenance_message').notNull().default('We are performing scheduled maintenance. Please try again shortly.'),
  updatedBy: integer('updated_by').references(() => adminsTable.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const platformModulesTable = pgTable('platform_modules', {
  moduleKey: varchar('module_key', { length: 80 }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('available'),
  statusMessage: text('status_message'),
  sortOrder: integer('sort_order').notNull().default(0),
  updatedBy: integer('updated_by').references(() => adminsTable.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const userModuleAccessTable = pgTable('user_module_access', {
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  moduleKey: varchar('module_key', { length: 80 }).notNull().references(() => platformModulesTable.moduleKey, { onDelete: 'cascade' }),
  isEnabled: boolean('is_enabled').notNull(),
  updatedBy: integer('updated_by').references(() => adminsTable.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.moduleKey], name: 'user_module_access_pk' }),
  userIdx: index('user_module_access_user_idx').on(table.userId),
}));

export const platformAccessAuditTable = pgTable('platform_access_audit', {
  id: serial('id').primaryKey(),
  targetType: varchar('target_type', { length: 30 }).notNull(),
  targetKey: varchar('target_key', { length: 120 }).notNull(),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  adminId: integer('admin_id').references(() => adminsTable.id, { onDelete: 'set null' }),
  beforeValue: jsonb('before_value').$type<Record<string, unknown> | null>(),
  afterValue: jsonb('after_value').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  targetIdx: index('platform_access_audit_target_idx').on(table.targetType, table.targetKey, table.createdAt),
  userIdx: index('platform_access_audit_user_idx').on(table.userId, table.createdAt),
  adminIdx: index('platform_access_audit_admin_idx').on(table.adminId),
}));

export type PlatformSettingsRecord = typeof platformSettingsTable.$inferSelect;
export type PlatformModuleRecord = typeof platformModulesTable.$inferSelect;
export type UserModuleAccessRecord = typeof userModuleAccessTable.$inferSelect;
