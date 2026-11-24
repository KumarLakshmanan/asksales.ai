import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Outreach Conversations Schema
 * Tracks all outreach conversations (email/instagram DM) with leads
 */

import { pgTable, serial, integer, bigint, varchar, text, timestamp, boolean, jsonb, index, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { leadsTable } from '../leads/schema';
import { usersTable } from '../users/schema';
import { storageFilesTable } from '../storageFiles/schema';
import { crmContactsTable } from '../crmContacts/schema';

/**
 * Outreach Conversations Table
 * Each row represents a conversation thread with a lead
 */
export const outreachConversationsTable = pgTable('outreach_conversations', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  leadId: integer('lead_id').notNull().references(() => leadsTable.id, { onDelete: 'cascade' }),
  crmContactId: integer('crm_contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  
  // Channel information
  channel: varchar('channel', { length: 50 }).notNull(), // 'email', 'instagram', 'linkedin', 'sms', 'gmail'
  
  // Integration provider that started this conversation (for email: 'resend' or 'gmail')
  integrationProvider: varchar('integration_provider', { length: 50 }),
  
  providerAccountId: varchar('provider_account_id', { length: 255 }),

  // Brand Toolkit this outreach thread was created with (FK in migration 589).
  // Follow-ups and replies render with it; NULL falls back to the default brand.
  brandToolkitId: integer('brand_toolkit_id'),

  // Lead details (denormalized for quick access)
  leadName: varchar('lead_name', { length: 255 }),
  leadEmail: varchar('lead_email', { length: 255 }),
  leadInstagram: varchar('lead_instagram', { length: 255 }),
  leadAvatar: text('lead_avatar'),
  leadCompany: varchar('lead_company', { length: 255 }),
  
  // Thread identifiers
  threadKey: uuid('thread_key').notNull().defaultRandom(), // Stable application thread identity, assigned before provider send
  externalThreadId: varchar('external_thread_id', { length: 255 }), // Gmail thread ID or Instagram thread ID
  
  // Email subject (stored on conversation so replies can compute "Re: <original subject>")
  subject: text('subject'),
  
  // Conversation status
  status: varchar('status', { length: 50 }).notNull().default('active'), // 'active', 'replied', 'closed', 'bounced', 'unsubscribed'
  automationMode: varchar('automation_mode', { length: 24 }).notNull().default('ai_active'), // ai_active | approval_pending | human_owned | resolved
  sessionEndedAt: timestamp('session_ended_at'),
  lastMessageAt: timestamp('last_message_at'),
  lastMessageBy: varchar('last_message_by', { length: 50 }), // 'user' or 'lead'
  lastMessagePreview: text('last_message_preview'),
  
  // Counts
  totalMessages: integer('total_messages').default(0),
  unreadCount: integer('unread_count').default(0),
  
  // Metadata
  metadata: jsonb('metadata'), // Additional channel-specific data
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('outreach_conversations_user_id_idx').on(table.userId),
  leadIdIdx: index('outreach_conversations_lead_id_idx').on(table.leadId),
  crmContactIdIdx: index('outreach_conversations_crm_contact_idx').on(table.userId, table.crmContactId),
  channelIdx: index('outreach_conversations_channel_idx').on(table.channel),
  statusIdx: index('outreach_conversations_status_idx').on(table.status),
  lastMessageAtIdx: index('outreach_conversations_last_message_at_idx').on(table.lastMessageAt),
  externalThreadIdIdx: index('outreach_conversations_external_thread_id_idx').on(table.externalThreadId),
  // Social channels retain completed sessions, with one current session for
  // each contact and receiving account. Email retains its native threads.
  singleChannelUq: uniqueIndex('outreach_conversations_single_channel_uq')
    .on(table.businessProfileId, table.userId, table.leadId, table.channel)
    .where(sql`${table.channel} NOT IN ('email', 'gmail', 'threads', 'whatsapp', 'facebook', 'instagram')`),
  socialSessionUq: uniqueIndex('outreach_conversations_social_session_uq')
    .on(table.businessProfileId, table.userId, table.leadId, table.channel, sql`COALESCE(${table.providerAccountId}, '')`)
    .where(sql`${table.channel} IN ('whatsapp', 'facebook', 'instagram') AND ${table.sessionEndedAt} IS NULL`),
  emailThreadKeyUq: uniqueIndex('outreach_conversations_email_thread_key_uq')
    .on(table.businessProfileId, table.userId, table.leadId, table.threadKey)
    .where(sql`${table.channel} IN ('email', 'gmail')`),
  providerThreadUq: uniqueIndex('outreach_conversations_provider_thread_uq')
    .on(table.businessProfileId, table.userId, table.leadId, table.integrationProvider, table.externalThreadId)
    .where(sql`${table.channel} IN ('email', 'gmail') AND ${table.integrationProvider} IS NOT NULL AND ${table.externalThreadId} IS NOT NULL`),
}));

/**
 * Outreach Messages Table
 * Each row represents a single message in a conversation
 */
export const outreachMessagesTable = pgTable('outreach_messages', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').notNull().references(() => outreachConversationsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  
  // Message direction
  direction: varchar('direction', { length: 20 }).notNull(), // 'outbound' (from user) or 'inbound' (from lead)
  
  // Message content
  subject: text('subject'), // For emails
  content: text('content').notNull(),
  // The redacted copy is the only form allowed into prompts, search, audit, and analytics.
  redactedContent: text('redacted_content'),
  inboxSearchText: text('inbox_search_text'),
  // Encrypted original in support_privacy_vault. Only the audited owner email
  // presentation may restore contact details; model/history reads stay redacted.
  privacyVaultId: bigint('privacy_vault_id', { mode: 'number' }),
  deliveryActionId: bigint('delivery_action_id', { mode: 'number' }),
  htmlContent: text('html_content'), // HTML version for emails
  
  // Attachments
  attachments: jsonb('attachments'), // Array of attachment URLs/metadata
  imageUrl: text('image_url'),
  videoUrl: text('video_url'),
  
  // External IDs
  externalMessageId: varchar('external_message_id', { length: 255 }), // Legacy provider/native ID used by webhooks
  providerMessageId: varchar('provider_message_id', { length: 255 }), // Gmail internal ID, Resend API email ID, or channel-native ID
  rfcMessageId: varchar('rfc_message_id', { length: 998 }), // Exact RFC Message-ID header; never synthesized from a provider ID
  wabaMessageId: varchar('waba_message_id', { length: 255 }), // Idempotency is scoped to the receiving WhatsApp account below.
  
  // WhatsApp specific
  phoneNumberId: varchar('phone_number_id', { length: 255 }), // Fast lookup for tenant routing
  messageType: varchar('message_type', { length: 50 }), // 'text', 'image', 'document', 'template', 'interactive'

  
  // Delivery status
  status: varchar('status', { length: 50 }).notNull().default('pending'), // pending | sending | sent | delivered | read | failed | bounced | manual_review
  sendIntentId: uuid('send_intent_id').notNull().defaultRandom(),
  idempotencyKey: varchar('idempotency_key', { length: 200 }),
  providerCallState: varchar('provider_call_state', { length: 32 }).notNull().default('not_started'), // not_started | started | confirmed | rejected | unknown
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  confirmedAt: timestamp('confirmed_at'),
  confirmationExpiresAt: timestamp('confirmation_expires_at'),
  manualReviewRequired: boolean('manual_review_required').notNull().default(false),
  sendAttemptCount: integer('send_attempt_count').notNull().default(0),
  sendClaimedAt: timestamp('send_claimed_at'),
  sentAt: timestamp('sent_at'),
  deliveredAt: timestamp('delivered_at'),
  readAt: timestamp('read_at'),
  failedAt: timestamp('failed_at'),
  errorMessage: text('error_message'),
  
  // Sequence tracking
  campaignId: integer('campaign_id'),
  sequenceStep: integer('sequence_step'),
  isAutomatic: boolean('is_automatic').default(false), // Auto-sent from sequence
  // Follow-up ownership is explicit so an automated follow-up can never become
  // the origin of another sequence. Outreach and social support replies may own a schedule.
  messageKind: varchar('message_kind', { length: 24 }).notNull().default('outreach'), // outreach | follow_up | reply
  followUpOriginMessageId: integer('follow_up_origin_message_id')
    .references((): AnyPgColumn => outreachMessagesTable.id, { onDelete: 'set null' }),
  followUpStep: integer('follow_up_step'),
  followUpCancelledAt: timestamp('follow_up_cancelled_at'),

  // Message tracking. The outreach launch (outreach_batches.id) this message
  // belongs to, and the WhatsApp template it was sent with. Follow-ups copy the
  // batch of the message they follow.
  batchId: uuid('batch_id'),
  templateName: varchar('template_name', { length: 512 }),
  templateLanguage: varchar('template_language', { length: 20 }),

  // AI-generated content tracking
  isAiGenerated: boolean('is_ai_generated').default(false),
  aiPrompt: text('ai_prompt'),
  
  // Read/unread status for inbound messages
  isRead: boolean('is_read').default(false),
  
  // Metadata
  metadata: jsonb('metadata'), // Additional message-specific data
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  conversationIdIdx: index('outreach_messages_conversation_id_idx').on(table.conversationId),
  userIdIdx: index('outreach_messages_user_id_idx').on(table.userId),
  directionIdx: index('outreach_messages_direction_idx').on(table.direction),
  statusIdx: index('outreach_messages_status_idx').on(table.status),
  sendIntentUq: uniqueIndex('outreach_messages_send_intent_uq').on(table.sendIntentId),
  userIdempotencyUq: uniqueIndex('outreach_messages_user_idempotency_uq')
    .on(table.businessProfileId, table.userId, table.idempotencyKey)
    .where(sql`${table.userId} IS NOT NULL AND ${table.idempotencyKey} IS NOT NULL`),
  manualReviewIdx: index('outreach_messages_manual_review_idx')
    .on(table.userId, table.manualReviewRequired, table.createdAt),
  sentAtIdx: index('outreach_messages_sent_at_idx').on(table.sentAt),
  campaignIdIdx: index('outreach_messages_campaign_id_idx').on(table.campaignId),
  followUpOriginIdx: index('outreach_messages_follow_up_origin_idx').on(table.followUpOriginMessageId),
  followUpOriginStepUq: uniqueIndex('outreach_messages_follow_up_origin_step_uq')
    .on(table.followUpOriginMessageId, table.followUpStep)
    .where(sql`${table.messageKind} = 'follow_up' AND ${table.followUpOriginMessageId} IS NOT NULL AND ${table.followUpStep} IS NOT NULL`),
  externalMessageIdIdx: index('outreach_messages_external_message_id_idx').on(table.externalMessageId),
  providerMessageIdIdx: index('outreach_messages_provider_message_id_idx').on(table.providerMessageId),
  rfcMessageIdIdx: index('outreach_messages_rfc_message_id_idx').on(table.rfcMessageId),
  wabaMessageIdIdx: index('outreach_messages_waba_message_id_idx').on(table.wabaMessageId),
  wabaAccountMessageUq: uniqueIndex('outreach_messages_waba_account_message_uq')
    .on(table.businessProfileId, table.userId, table.phoneNumberId, table.wabaMessageId)
    .where(sql`${table.wabaMessageId} IS NOT NULL`),
  phoneNumberIdIdx: index('outreach_messages_phone_number_id_idx').on(table.phoneNumberId),
  batchStatusIdx: index('outreach_messages_batch_status_idx').on(table.batchId, table.messageKind, table.status)
    .where(sql`${table.batchId} IS NOT NULL`),
  batchIdIdx: index('outreach_messages_batch_id_idx').on(table.batchId, table.id)
    .where(sql`${table.batchId} IS NOT NULL`),
}));

/**
 * Durable attachment records. Uploads are staged without a message and then
 * claimed by exactly one message owned by the same tenant before delivery.
 * Provider and extraction state are kept independently so the UI never
 * confuses "stored" with "delivered" or "understood by AI".
 */
export const outreachMessageAttachmentsTable = pgTable('outreach_message_attachments', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  messageId: integer('message_id').references(() => outreachMessagesTable.id, { onDelete: 'cascade' }),
  storageFileId: integer('storage_file_id').references(() => storageFilesTable.id, { onDelete: 'restrict' }),
  direction: varchar('direction', { length: 20 }).notNull(),
  source: varchar('source', { length: 30 }).notNull().default('upload'),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 200 }).notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  status: varchar('status', { length: 24 }).notNull().default('ready'),
  extractionStatus: varchar('extraction_status', { length: 24 }).notNull().default('pending'),
  extractedText: text('extracted_text'),
  extractionError: text('extraction_error'),
  deliveryStatus: varchar('delivery_status', { length: 24 }).notNull().default('pending'),
  deliveryError: text('delivery_error'),
  providerAttachmentId: varchar('provider_attachment_id', { length: 255 }),
  providerMediaId: varchar('provider_media_id', { length: 255 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdx: index('outreach_message_attachments_user_idx').on(table.userId),
  messageIdx: index('outreach_message_attachments_message_idx').on(table.messageId),
  storageFileIdx: index('outreach_message_attachments_storage_file_idx').on(table.storageFileId),
  stagedExpiryIdx: index('outreach_message_attachments_staged_expiry_idx').on(table.expiresAt),
  messageFileUq: uniqueIndex('outreach_message_attachments_message_file_uq')
    .on(table.messageId, table.storageFileId)
    .where(sql`${table.messageId} IS NOT NULL AND ${table.storageFileId} IS NOT NULL`),
  providerAttachmentUq: uniqueIndex('outreach_message_attachments_provider_uq')
    .on(table.businessProfileId, table.userId, table.providerAttachmentId)
    .where(sql`${table.providerAttachmentId} IS NOT NULL`),
  ttsMessageUq: uniqueIndex('outreach_message_attachments_tts_message_uq')
    .on(table.messageId, table.source)
    .where(sql`${table.messageId} IS NOT NULL AND ${table.source} = 'tts'`),
}));

// Export types
export type OutreachConversationRecord = typeof outreachConversationsTable.$inferSelect;
export type InsertOutreachConversation = typeof outreachConversationsTable.$inferInsert;

export type OutreachMessageRecord = typeof outreachMessagesTable.$inferSelect;
export type InsertOutreachMessage = typeof outreachMessagesTable.$inferInsert;
export type OutreachMessageAttachmentRecord = typeof outreachMessageAttachmentsTable.$inferSelect;
export type InsertOutreachMessageAttachment = typeof outreachMessageAttachmentsTable.$inferInsert;
