import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, boolean, timestamp, index, jsonb } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { supportTeamsTable } from '../supportTeams/schema';

export interface SupportMemberChannelPreference {
  enabled: boolean;
  recipient: string;
  events: {
    newTicketAssignment: boolean;
    humanHandoff: boolean;
    ticketCreatedUnassigned?: boolean;
    ticketAssigned?: boolean;
    ticketReassigned?: boolean;
    customerReplied?: boolean;
    ticketReopened?: boolean;
    slaAtRisk?: boolean;
    slaBreached?: boolean;
    approvalRequired?: boolean;
    deliveryFailed?: boolean;
    ticketResolved?: boolean;
  };
}

export interface SupportMemberNotificationPreferences {
  email: SupportMemberChannelPreference;
  whatsapp: SupportMemberChannelPreference;
  slack?: SupportMemberChannelPreference;
  teams?: SupportMemberChannelPreference;
}

export const DEFAULT_SUPPORT_MEMBER_NOTIFICATION_PREFERENCES: SupportMemberNotificationPreferences = {
  email: { enabled: false, recipient: '', events: { newTicketAssignment: true, humanHandoff: true } },
  whatsapp: { enabled: false, recipient: '', events: { newTicketAssignment: true, humanHandoff: true } },
  slack: { enabled: false, recipient: '', events: { newTicketAssignment: true, humanHandoff: true } },
  teams: { enabled: false, recipient: '', events: { newTicketAssignment: true, humanHandoff: true } },
};

export const teamMembersTable = pgTable('team_members', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  teamId: integer('team_id').notNull().references(() => supportTeamsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 50 }).notNull().default('member'),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  passwordHash: varchar('password_hash', { length: 255 }),
  passwordChangedAt: timestamp('password_changed_at'),
  notificationPreferences: jsonb('notification_preferences')
    .$type<SupportMemberNotificationPreferences>()
    .default(DEFAULT_SUPPORT_MEMBER_NOTIFICATION_PREFERENCES)
    .notNull(),
  isOnCall: boolean('is_on_call').notNull().default(false),
  locale: varchar('locale', { length: 24 }).notNull().default('en-IN'),
  timezone: varchar('timezone', { length: 100 }).notNull().default('Asia/Kolkata'),
  quietHours: jsonb('quiet_hours').$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  teamIdIdx: index('idx_team_members_team_id').on(table.teamId),
  userIdIdx: index('idx_team_members_user_id').on(table.userId),
  uniqueMember: index('idx_team_members_unique').on(table.teamId, table.userId),
  emailIdx: index('idx_team_members_email').on(table.email),
}));
