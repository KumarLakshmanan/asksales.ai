/**
 * Email Senders Model Functions
 * CRUD operations for the email_senders table
 */

import { db } from '../db';
import { emailSendersTable, type EmailSenderRecord, type InsertEmailSender } from './schema';
import { eq, and, sql } from 'drizzle-orm';

/**
 * List all email senders for a user
 */
export async function listByUser(userId: number): Promise<EmailSenderRecord[]> {
  return db
    .select()
    .from(emailSendersTable)
    .where(eq(emailSendersTable.userId, userId))
    .orderBy(emailSendersTable.createdAt);
}

/**
 * Get a single sender by ID (with ownership check)
 */
export async function getById(userId: number, id: number): Promise<EmailSenderRecord | undefined> {
  const [row] = await db
    .select()
    .from(emailSendersTable)
    .where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId)));
  return row;
}

/**
 * Get the default sender for a user. Falls back to the first verified sender.
 */
export async function getDefault(userId: number): Promise<EmailSenderRecord | undefined> {
  // Try explicit default first
  const [defaultRow] = await db
    .select()
    .from(emailSendersTable)
    .where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.isDefault, true)));
  if (defaultRow) return defaultRow;

  // Fallback: first verified sender
  const [firstVerified] = await db
    .select()
    .from(emailSendersTable)
    .where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.isVerified, true)))
    .orderBy(emailSendersTable.createdAt)
    .limit(1);
  return firstVerified;
}

/**
 * Create a new email sender. If it's the first sender for the user, auto-set as default.
 */
export async function create(data: InsertEmailSender): Promise<EmailSenderRecord> {
  // Check if user has any senders yet
  const existing = await db
    .select({ count: sql<number>`count(*)` })
    .from(emailSendersTable)
    .where(eq(emailSendersTable.userId, data.userId));

  const isFirst = (existing[0]?.count ?? 0) === 0;

  const [row] = await db
    .insert(emailSendersTable)
    .values({ ...data, isDefault: isFirst ? true : (data.isDefault ?? false) })
    .returning();
  return row;
}

/**
 * Update a sender
 */
export async function update(
  userId: number,
  id: number,
  data: Partial<Pick<InsertEmailSender, 'label' | 'email' | 'displayName' | 'isVerified' | 'config' | 'credentialId'>>
): Promise<EmailSenderRecord | undefined> {
  const [row] = await db
    .update(emailSendersTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId)))
    .returning();
  return row;
}

/**
 * Set a sender as the default (clears previous default)
 */
export async function setDefault(userId: number, id: number): Promise<void> {
  // Clear existing default
  await db
    .update(emailSendersTable)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.isDefault, true)));
  // Set new default
  await db
    .update(emailSendersTable)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId)));
}

/**
 * Delete a sender
 */
export async function remove(userId: number, id: number): Promise<boolean> {
  const result = await db
    .delete(emailSendersTable)
    .where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId)))
    .returning();
  return result.length > 0;
}

/**
 * Find sender by resend_domain_id for a user
 */
export async function findByResendDomain(userId: number, resendDomainId: number): Promise<EmailSenderRecord | undefined> {
  const [row] = await db
    .select()
    .from(emailSendersTable)
    .where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.resendDomainId, resendDomainId)));
  return row;
}

/**
 * Find sender by credential_id for a user (Gmail)
 */
export async function findByCredential(userId: number, credentialId: number): Promise<EmailSenderRecord | undefined> {
  const [row] = await db
    .select()
    .from(emailSendersTable)
    .where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.credentialId, credentialId)));
  return row;
}

/**
 * Find sender by email address and type for a user (deduplication)
 */
export async function findByEmailAndType(userId: number, email: string, type: string): Promise<EmailSenderRecord | undefined> {
  const [row] = await db
    .select()
    .from(emailSendersTable)
    .where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.email, email), eq(emailSendersTable.type, type)));
  return row;
}
