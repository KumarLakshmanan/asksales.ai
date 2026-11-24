import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, boolean, index, jsonb } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';

export const supportTeamsTable = pgTable('support_teams', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  color: varchar('color', { length: 20 }).default('#6366f1'),
  icon: varchar('icon', { length: 50 }).default('users'),
  widgetSettings: jsonb('widget_settings').$type<import('../../../shared/supportWidgetSettings.js').SupportWidgetSettings>().notNull().default({ displayName: '', greeting: 'Hi! How can we help you today?', primaryColor: '#6366f1', logoUrl: '', launcherPosition: 'right' }),
  widgetInstallation: jsonb('widget_installation').$type<import('../../../shared/supportWidgetSettings.js').WidgetInstallation>(),
  widgetToken: varchar('widget_token', { length: 64 }).unique(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_support_teams_user_id').on(table.userId),
}));
