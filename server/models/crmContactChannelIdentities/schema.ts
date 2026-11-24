import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, bigserial, integer, varchar, jsonb, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';
import { leadsTable } from '../leads/schema.js';
import { crmContactsTable } from '../crmContacts/schema.js';

export interface EncryptedChannelIdentifier {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export const crmContactChannelIdentitiesTable = pgTable('crm_contact_channel_identities', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => crmContactsTable.id, { onDelete: 'cascade' }),
  leadId: integer('lead_id').references(() => leadsTable.id, { onDelete: 'set null' }),
  channel: varchar('channel', { length: 50 }).notNull(),
  identifierType: varchar('identifier_type', { length: 50 }).notNull(),
  identifierFingerprint: varchar('identifier_fingerprint', { length: 96 }).notNull(),
  encryptedIdentifier: jsonb('encrypted_identifier').$type<EncryptedChannelIdentifier | null>(),
  verificationLevel: varchar('verification_level', { length: 32 }).notNull().default('provider'),
  source: varchar('source', { length: 100 }).notNull().default('inbound'),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  tenantIdentityUq: unique().on(table.businessProfileId, table.userId, table.channel, table.identifierFingerprint),
  contactIdx: index('crm_contact_channel_identities_contact_idx').on(table.userId, table.contactId, table.lastSeenAt),
  identifierIdx: index('crm_contact_channel_identities_identifier_idx').on(table.userId, table.identifierType, table.identifierFingerprint),
}));

export type CrmContactChannelIdentityRecord = typeof crmContactChannelIdentitiesTable.$inferSelect;
