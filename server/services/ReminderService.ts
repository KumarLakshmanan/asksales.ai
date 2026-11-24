import { randomUUID } from 'node:crypto';
import { deliverReminderNotification, ReminderNotificationUncertainError } from './ReminderNotificationDeliveryService.js';
import { db } from '../models/db';
import { proposalRemindersTable } from '../models/proposalReminders/schema';
import { crmActivityRemindersTable } from '../models/crmActivityReminders/schema';
import { crmActivitiesTable } from '../models/crmActivities/schema';
import { crmContactsTable } from '../models/crmContacts/schema';
import { eq, and, lte, sql, inArray } from 'drizzle-orm';
import { validateCrmAssignee } from './CRMAssigneeService.js';
import { CrmConfigurationError } from './CRMConfigurationService.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { logger } from '../utils/logger.js';
import { sendAdminEmail } from './adminEmailService';
import { renderAdminEmail, getBrandInfo, renderBrandedEmail } from '../utils/emailTemplates';
import { DEFAULT_BUSINESS_TIMEZONE, zonedDateTimeToUtc } from '../utils/timezone.js';
import { escapeHtml } from '../../shared/html.js';

// Reminder types available in CRM
export const REMINDER_TYPES = [
  'followup',
  'ticket_open',
  'ticket_close',
  'proposal_sent',
  'proposal_expiry',
  'meeting',
  'call',
  'task',
  'custom',
] as const;

class ReminderService {
  private static instance: ReminderService;

  static getInstance(): ReminderService {
    if (!this.instance) this.instance = new ReminderService();
    return this.instance;
  }

  // Proposal reminders
  async createProposalReminder(userId: number, proposalId: number, data: {
    reminderDueAt: Date;
    reminderType?: string;
    timezone?: string;
  }) {
    const [reminder] = await db.insert(proposalRemindersTable).values({
      proposalId,
      userId,
      reminderDueAt: data.reminderDueAt,
      reminderType: data.reminderType || 'expiry',
      timezone: data.timezone || DEFAULT_BUSINESS_TIMEZONE,
    }).returning();
    return reminder;
  }

  async getProposalReminders(userId: number, proposalId?: number) {
    const conditions = [eq(proposalRemindersTable.userId, userId)];
    if (proposalId) conditions.push(eq(proposalRemindersTable.proposalId, proposalId));

    return db.select().from(proposalRemindersTable)
      .where(and(...conditions))
      .orderBy(proposalRemindersTable.reminderDueAt)
      .limit(200);
  }

  async updateProposalReminder(userId: number, reminderId: number, data: Partial<{
    reminderDueAt: Date;
    status: string;
    snoozedUntil: Date;
  }>) {
    const [updated] = await db.update(proposalRemindersTable)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(proposalRemindersTable.id, reminderId), eq(proposalRemindersTable.userId, userId)))
      .returning();
    return updated || null;
  }

  async deleteProposalReminder(userId: number, reminderId: number) {
    const deleted = await db.delete(proposalRemindersTable)
      .where(and(eq(proposalRemindersTable.id, reminderId), eq(proposalRemindersTable.userId, userId)))
      .returning({ id: proposalRemindersTable.id });
    return deleted.length > 0;
  }

  // Activity reminders (general CRM reminders)
  async createActivityReminder(userId: number, data: {
    activityId?: number;
    contactId?: number;
    reminderDueAt: Date;
    reminderType?: string;
    title?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    timezone?: string;
  }) {
    return db.transaction(async (tx: any) => {
      const scope = currentBusinessScope();
      const metadata: Record<string,unknown> = { ...(data.metadata || {}), ...(scope ? { actorUserId: scope.actorUserId || userId } : {}) };
      await validateCrmAssignee(userId, metadata.assignedTo as number | null | undefined, tx);
      if (data.contactId) await this.lockReminderContact(tx,userId,data.contactId);
      if (data.activityId) {
        const [activity] = await tx.select().from(crmActivitiesTable).where(and(eq(crmActivitiesTable.id,data.activityId),eq(crmActivitiesTable.userId,userId))).limit(1);
        if (!activity || (data.contactId && activity.contactId !== data.contactId)) throw new CrmConfigurationError('Choose an activity belonging to this contact.',400);
      }
      const [reminder] = await tx.insert(crmActivityRemindersTable).values({
        userId,activityId: data.activityId || null,contactId: data.contactId || null,
        reminderDueAt: data.reminderDueAt,reminderType: data.reminderType || 'followup',title: data.title || null,
        description: data.description || null,timezone: data.timezone || DEFAULT_BUSINESS_TIMEZONE,metadata,
      }).returning();
      if (data.contactId) await this.syncContactFollowup(tx,userId,data.contactId);
      return reminder;
    });
  }

  private async lockReminderContact(tx: any,userId: number,contactId: number,required=true) {
    const result = await tx.execute(sql`SELECT id FROM crm_contacts WHERE id=${contactId} AND user_id=${userId} AND deleted_at IS NULL FOR UPDATE`);
    if (!result.rows.length && required) throw new CrmConfigurationError('Contact not found.',404);
  }

  private async syncContactFollowup(tx: any,userId: number,contactId: number) {
    // Sending (or failing to send) a notification does not complete the action.
    // Keep the same open statuses as Reminders and My Work.
    await tx.execute(sql`UPDATE crm_contacts contact SET next_follow_up_at=(
      SELECT MIN(COALESCE(reminder.snoozed_until,reminder.reminder_due_at)) FROM crm_activity_reminders reminder
      WHERE reminder.user_id=${userId} AND reminder.contact_id=contact.id
        AND reminder.business_profile_id IS NOT DISTINCT FROM contact.business_profile_id AND reminder.status NOT IN ('completed','cancelled')),
      updated_at=NOW() WHERE contact.id=${contactId} AND contact.user_id=${userId} AND contact.deleted_at IS NULL`);
  }

  async getActivityReminders(userId: number, filters?: {
    contactId?: number;
    status?: string;
  }) {
    const conditions = [eq(crmActivityRemindersTable.userId, userId)];
    if (filters?.contactId) conditions.push(eq(crmActivityRemindersTable.contactId, filters.contactId));
    if (filters?.status) conditions.push(eq(crmActivityRemindersTable.status, filters.status));

    return db.select().from(crmActivityRemindersTable)
      .where(and(...conditions))
      .orderBy(crmActivityRemindersTable.reminderDueAt);
  }

  async updateActivityReminder(userId: number, reminderId: number, data: Partial<{
    reminderDueAt: Date; status: string; title: string; description: string;
    snoozedUntil: Date | null; metadata: Record<string, unknown>;
  }>) {
    return db.transaction(async (tx: any) => {
      const [initial] = await tx.select().from(crmActivityRemindersTable)
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,userId))).limit(1);
      if (!initial) return null;
      if (initial.contactId) await this.lockReminderContact(tx,userId,initial.contactId);
      const [current] = await tx.select().from(crmActivityRemindersTable)
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,userId))).limit(1).for('update');
      if (!current) return null;
      if (current.lastSentAt && !current.sentAt && ['pending','snoozed'].includes(current.status)
        && Date.now()-new Date(current.lastSentAt).getTime()<3_600_000)
        throw new CrmConfigurationError('This reminder is currently being delivered. Refresh it before making changes.',409);
      if (data.metadata && 'assignedTo' in data.metadata) await validateCrmAssignee(userId,data.metadata.assignedTo as number | null,tx);
      const scope = currentBusinessScope();
      const rescheduled = Boolean(data.reminderDueAt && new Date(current.reminderDueAt).getTime() !== data.reminderDueAt.getTime());
      const snoozing = Boolean(data.snoozedUntil);
      const newNotificationIntent = rescheduled
        || (snoozing && (current.status !== 'snoozed' || new Date(current.snoozedUntil || 0).getTime() !== data.snoozedUntil!.getTime()))
        || (data.status === 'pending' && current.status !== 'pending');
      const updates = { ...data,
        ...(rescheduled ? { status: data.status || 'pending',sentAt: null,lastSentAt: null,snoozedUntil: null } : {}),
        ...(snoozing ? { status: 'snoozed',reminderDueAt: data.snoozedUntil!,snoozedUntil: data.snoozedUntil!,sentAt: null,lastSentAt: null } : {}),
        ...(data.status === 'pending' && !snoozing ? { snoozedUntil: null,sentAt: null,lastSentAt: null } : {}),
        metadata: { ...(current.metadata || {}),...(data.metadata || {}),
          ...(newNotificationIntent ? { notificationGeneration: randomUUID(),retry_count: 0,last_error: null } : {}),...(scope ? { actorUserId: scope.actorUserId || userId } : {}) },updatedAt: new Date(),
      };
      const [updated] = await tx.update(crmActivityRemindersTable).set(updates)
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,userId))).returning();
      if (updated?.contactId) await this.syncContactFollowup(tx,userId,updated.contactId);
      return updated || null;
    });
  }

  async deleteActivityReminder(userId: number, reminderId: number) {
    return db.transaction(async (tx: any) => {
      const [initial] = await tx.select().from(crmActivityRemindersTable)
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,userId))).limit(1);
      if (!initial) return false;
      if (initial.contactId) await this.lockReminderContact(tx,userId,initial.contactId);
      const [current] = await tx.select().from(crmActivityRemindersTable)
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,userId))).limit(1).for('update');
      if (!current) return false;
      if (current.lastSentAt && !current.sentAt && ['pending','snoozed'].includes(current.status)
        && Date.now()-new Date(current.lastSentAt).getTime()<3_600_000)
        throw new CrmConfigurationError('This reminder is currently being delivered. Refresh it before deleting it.',409);
      const deleted = await tx.delete(crmActivityRemindersTable)
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,userId))).returning();
      if (current.contactId) await this.syncContactFollowup(tx,userId,current.contactId);
      return deleted.length>0;
    });
  }

  // Due reminders check (for cron jobs)
  async getDueReminders() {
    const now = new Date();

    const [proposalReminders, activityReminders] = await Promise.all([
      db.select().from(proposalRemindersTable)
        .where(and(
          eq(proposalRemindersTable.status, 'pending'),
          lte(proposalRemindersTable.reminderDueAt, now)
        )),
      db.select().from(crmActivityRemindersTable)
        .where(and(
          inArray(crmActivityRemindersTable.status, ['pending','snoozed']),
          sql`COALESCE(${crmActivityRemindersTable.snoozedUntil},${crmActivityRemindersTable.reminderDueAt}) <= ${now}`
        )),
    ]);

    return { proposalReminders, activityReminders };
  }

  async markReminderSent(type: 'proposal' | 'activity', reminderId: number) {
    if (type === 'proposal') {
      await db.update(proposalRemindersTable).set({ status: 'sent',sentAt: new Date(),updatedAt: new Date() }).where(eq(proposalRemindersTable.id,reminderId));
      return;
    }
    await db.transaction(async (tx: any) => {
      const [reminder] = await tx.select().from(crmActivityRemindersTable).where(eq(crmActivityRemindersTable.id,reminderId)).limit(1);
      if (!reminder) return;
      if (reminder.contactId) await this.lockReminderContact(tx,reminder.userId,reminder.contactId,false);
      await tx.update(crmActivityRemindersTable).set({ status: 'sent',sentAt: new Date(),updatedAt: new Date() }).where(eq(crmActivityRemindersTable.id,reminderId));
      if (reminder.contactId) await this.syncContactFollowup(tx,reminder.userId,reminder.contactId);
    });
  }

  /** Keep the contact's follow-up date in step with delivery retries and failures. */
  private async updateActivityReminderDeliveryState(reminderId: number,changes: Partial<typeof crmActivityRemindersTable.$inferInsert>) {
    await db.transaction(async (tx: any) => {
      const [reminder] = await tx.select().from(crmActivityRemindersTable)
        .where(eq(crmActivityRemindersTable.id,reminderId)).limit(1);
      if (!reminder) return;
      if (reminder.contactId) await this.lockReminderContact(tx,reminder.userId,reminder.contactId,false);
      const metadataPatch = changes.metadata && Object.fromEntries(Object.entries(changes.metadata)
        .filter(([key]) => key !== 'notificationDeliveries' && key !== 'notificationGeneration'));
      await tx.update(crmActivityRemindersTable).set({ ...changes, ...(metadataPatch ? {
        metadata: sql`COALESCE(${crmActivityRemindersTable.metadata},'{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb`,
      } : {}) })
        .where(and(eq(crmActivityRemindersTable.id,reminderId),eq(crmActivityRemindersTable.userId,reminder.userId)));
      if (reminder.contactId) await this.syncContactFollowup(tx,reminder.userId,reminder.contactId);
    });
  }

  /**
   * C7 — Atomically claim a reminder for processing. Returns true if this
   * caller successfully claimed it (and may proceed to send). Returns false
   * if another worker already claimed it within the past hour.
   *
   * Uses last_sent_at as the claim marker so a crashed worker auto-releases
   * after the cron interval (1h) and we retry instead of being stuck forever.
   */
  async tryClaimReminder(type: 'proposal' | 'activity', reminderId: number): Promise<boolean> {
    const tableName = type === 'proposal' ? 'proposal_reminders' : 'crm_activity_reminders';
    try {
      const r = await db.execute(sql.raw(
        `UPDATE ${tableName} SET last_sent_at = NOW() WHERE id = ${reminderId} AND ${type === 'activity' ? "status IN ('pending','snoozed') AND COALESCE(snoozed_until,reminder_due_at) <= NOW()" : "status = 'pending'"} AND (last_sent_at IS NULL OR (${type === 'proposal' ? "reminder_type <> 'customer_followup' AND" : ''} last_sent_at < NOW() - interval '1 hour')) RETURNING id`,
      ));
      return (r.rowCount ?? 0) > 0;
    } catch (err) {
      logger.warn({ err, reminderId, type }, '[ReminderService] tryClaimReminder failed');
      return false;
    }
  }

  /**
   * Get activity reminders with contact names joined, mapped to frontend-friendly fields
   */
  async getActivityRemindersWithContacts(userId: number, filters?: {
    contactId?: number;
    status?: string;
  }) {
    const conditions: ReturnType<typeof sql>[] = [
      sql`r.user_id = ${userId}`,
    ];
    if (filters?.contactId) conditions.push(sql`r.contact_id = ${filters.contactId}`);
    if (filters?.status) conditions.push(sql`r.status = ${filters.status}`);

    const whereClause = sql.join(conditions, sql` AND `);

    const result = await db.execute(sql`
      SELECT
        r.id,
        r.contact_id AS "contactId",
        COALESCE(
          TRIM(CONCAT(COALESCE(c.first_name, l.first_name, l.name, ''), ' ', COALESCE(c.last_name, l.last_name, ''))),
          NULL
        ) AS "contactName",
        COALESCE(c.email, l.email) AS "contactEmail",
        r.title,
        r.description,
        COALESCE(r.snoozed_until,r.reminder_due_at) AS "dueDate",
        CASE WHEN (r.metadata->>'assignedTo') ~ '^[0-9]{1,9}$' THEN (r.metadata->>'assignedTo')::integer ELSE NULL END AS "assignedTo",
        CASE WHEN (r.metadata->>'assignedTo') ~ '^[0-9]{1,9}$' THEN COALESCE(assigned.name,'Former team member') ELSE 'Workspace owner' END AS "assignedName",
        r.reminder_type AS "reminderType",
        r.status,
        r.sent_at AS "sentAt",
        r.snoozed_until AS "snoozedUntil",
        r.metadata,
        r.created_at AS "createdAt",
        COALESCE(r.metadata->>'priority', CASE
          -- Real reminder types: prioritize "needs action" and time-sensitive ones
          WHEN r.reminder_type IN ('meeting', 'call', 'proposal_sent', 'ticket_open') THEN 'high'
          WHEN r.reminder_type IN ('ticket_close', 'expiry') THEN 'low'
          WHEN r.reminder_type IN ('high') THEN 'high'
          WHEN r.reminder_type IN ('low') THEN 'low'
          WHEN r.reminder_type IN ('followup') THEN 'medium'
          ELSE 'medium'
        END) AS priority
      FROM crm_activity_reminders r
      LEFT JOIN crm_contacts c ON c.id = r.contact_id AND c.deleted_at IS NULL
      LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
      LEFT JOIN users assigned ON assigned.id=CASE WHEN (r.metadata->>'assignedTo') ~ '^[0-9]{1,9}$' THEN (r.metadata->>'assignedTo')::integer ELSE NULL END
        AND assigned.deleted_at IS NULL AND (assigned.id=${userId} OR EXISTS (SELECT 1 FROM business_profile_memberships member
          WHERE member.business_profile_id=r.business_profile_id AND member.user_id=assigned.id AND member.status='active'))
      WHERE ${whereClause}
      ORDER BY COALESCE(r.snoozed_until,r.reminder_due_at) ASC,r.id ASC
      LIMIT 1000
    `);

    return (result.rows || []) as Array<{
      id: number;
      contactId: number | null;
      contactName: string | null;
      contactEmail: string | null;
      title: string;
      description: string | null;
      dueDate: string;
      reminderType: string;
      status: string;
      sentAt: string | null;
      snoozedUntil: string | null;
      metadata: Record<string, unknown>;
      createdAt: string;
      priority: string; assignedTo: number | null; assignedName: string;
    }>;
  }

  /** Persist eligible internal reminders; reject persistence failures so the caller
   * can retry. Existing booking/kind rows and delivery receipts remain untouched. */
  async scheduleBookingReminders(userId: number, booking: {
    id: number;
    checkIn: string;
    checkOut: string;
    guestName?: string | null;
    timezone?: string;
    checkInTime?: string;
    checkOutTime?: string;
  }, contactId: number | null): Promise<void> {
    try {
      const timezone = booking.timezone || DEFAULT_BUSINESS_TIMEZONE;
      const checkInInstant = zonedDateTimeToUtc(
        booking.checkIn,
        booking.checkInTime || '14:00',
        timezone,
      );
      const checkOutInstant = zonedDateTimeToUtc(
        booking.checkOut,
        booking.checkOutTime || '11:00',
        timezone,
      );
      const checkInDate = checkInInstant
        ? new Date(checkInInstant.getTime() - 24 * 60 * 60 * 1000)
        : null;
      const checkOutDate = checkOutInstant
        ? new Date(checkOutInstant.getTime() - 2 * 60 * 60 * 1000)
        : null;
      const now = new Date();

      if (checkInDate && checkInDate > now) {
        await db.insert(crmActivityRemindersTable).values({
          userId,
          contactId: contactId || undefined,
          reminderDueAt: checkInDate,
          reminderType: 'custom',
          title: `Upcoming check-in · Booking #${booking.id}`,
          description: `${booking.guestName || 'Guest'} is scheduled to check in on ${booking.checkIn}. This is an internal hotel operations reminder.`,
          timezone,
          metadata: {
            source: 'hotel_booking',
            bookingId: String(booking.id),
            bookingReminderKind: 'check_in',
            notifyContact: false,
            timezone,
          },
        }).onConflictDoNothing();
      }

      if (checkOutDate && checkOutDate > now) {
        await db.insert(crmActivityRemindersTable).values({
          userId,
          contactId: contactId || undefined,
          reminderDueAt: checkOutDate,
          reminderType: 'custom',
          title: `Upcoming check-out · Booking #${booking.id}`,
          description: `${booking.guestName || 'Guest'} is scheduled to check out on ${booking.checkOut}. This is an internal hotel operations reminder.`,
          timezone,
          metadata: {
            source: 'hotel_booking',
            bookingId: String(booking.id),
            bookingReminderKind: 'check_out',
            notifyContact: false,
            timezone,
          },
        }).onConflictDoNothing();
      }

      logger.info({ bookingId: booking.id, userId }, '[ReminderService] Scheduled check-in/out reminders for booking');
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, '[ReminderService] Failed to schedule booking reminders');
      throw err;
    }
  }

  /**
   * Process due reminders. The responsible member or owner is notified; a contact is only
   * emailed when the reminder explicitly opted in via metadata.notifyContact.
   * Called by cron job. Only handles reminders with a future dueDate set by the user
   * (e.g. "contact me after a week").
   */
  async processAndSendDueReminders(): Promise<{ processed: number; errors: number }> {
    const { proposalReminders, activityReminders } = await this.getDueReminders();
    let processed = 0;
    let errors = 0;

    // Process activity reminders
    for (const reminder of activityReminders) {
      // C7 — Atomically claim before doing any work
      if (!(await this.tryClaimReminder('activity', reminder.id))) {
        continue;
      }
      try {
        // Fetch contact email if linked
        let contactEmail: string | null = null;
        let contactName: string | null = null;
        let userEmail: string | null = null;

        if (reminder.contactId) {
          const contactResult = await db.execute(sql`
            SELECT
              COALESCE(c.email, l.email) AS email,
              TRIM(CONCAT(COALESCE(c.first_name, l.first_name, l.name, ''), ' ', COALESCE(c.last_name, l.last_name, ''))) AS name
            FROM crm_contacts c
            LEFT JOIN leads l ON l.id = c.lead_id
            WHERE c.id = ${reminder.contactId} AND c.user_id = ${reminder.userId}
            LIMIT 1
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const row = (contactResult.rows as any)?.[0];
          if (row) {
            contactEmail = row.email;
            contactName = row.name?.trim() || null;
          }
        }

        // Fetch user email for notification
        const assignedTo = Number(reminder.metadata?.assignedTo);
        const recipient = Number.isSafeInteger(assignedTo) && assignedTo>0 ? assignedTo : reminder.userId;
        const userResult = await db.execute(sql`
          SELECT COALESCE(assigned.email,owner.email) AS email,COALESCE(assigned.name,owner.name,'User') AS name,
            COALESCE(owner.name,'Our team') AS sender_name FROM users owner
          LEFT JOIN users assigned ON assigned.id=${recipient} AND assigned.deleted_at IS NULL
            AND (assigned.id=owner.id OR EXISTS (SELECT 1 FROM business_profile_memberships member
              WHERE member.business_profile_id=${reminder.businessProfileId} AND member.user_id=assigned.id AND member.status='active'))
          WHERE owner.id=${reminder.userId} AND owner.deleted_at IS NULL LIMIT 1
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const user = (userResult.rows as any)?.[0];
        userEmail = user?.email;

        // Send the internal notification to the responsible active workspace member.
        if (!userEmail) {
          throw new Error('Reminder owner has no email address');
        }
        await deliverReminderNotification(reminder, 'internal', () => sendAdminEmail({
            to: userEmail,
            subject: `Reminder: ${reminder.title || 'CRM Reminder Due'}`,
            html: buildReminderEmailHtml({
              title: reminder.title || 'Reminder Due',
              description: reminder.description || '',
              contactName,
              contactEmail,
              dueAt: reminder.reminderDueAt,
              reminderType: reminder.reminderType,
            }),
        }));

        const notifyContact = reminder.metadata?.notifyContact === true;
        if (notifyContact && !contactEmail) {
          throw new Error('Contact notification was requested, but the contact has no email address');
        }

        // Contact delivery is explicit opt-in; internal reminders never send
        // customer-facing email by default.
        if (notifyContact && contactEmail) {
          // CRM reminders belong to a contact, not to one campaign or thread, so
          // they use the reminder's business default brand.
          const brand = await getBrandInfo(reminder.userId, null, reminder.businessProfileId);
          const emailSubject = getContactEmailSubject(reminder.reminderType, reminder.title);
          const emailBody = reminder.description || '';
          const contactDelivery = await deliverReminderNotification(reminder, 'contact', () => sendAdminEmail({
            to: contactEmail,
            subject: emailSubject,
            html: buildContactNotificationHtml({
              title: reminder.title || '',
              description: emailBody,
              reminderType: reminder.reminderType,
              contactName,
              senderName: user?.sender_name || 'Our Team',
              brand,
            }),
          }));

          // Log CRM activity when reminder email is successfully sent to contact
          try {
            if (!contactDelivery.skipped) await db.insert(crmActivitiesTable).values({
              userId: reminder.userId,
              contactId: reminder.contactId!,
              type: 'email_sent',
              subject: emailSubject,
              body: emailBody,
              metadata: {
                reminderId: reminder.id,
                reminderType: reminder.reminderType,
              },
            });
            // Update contact lastActivityAt
            await db.update(crmContactsTable)
              .set({ lastActivityAt: new Date(), updatedAt: new Date() })
              .where(eq(crmContactsTable.id, reminder.contactId!));
          } catch (actErr) {
            logger.warn({ err: actErr, reminderId: reminder.id }, '[ReminderService] Failed to log CRM activity for sent reminder');
          }
        }

        await this.markReminderSent('activity', reminder.id);
        processed++;
      } catch (err) {
        logger.error({ err, reminderId: reminder.id }, '[ReminderService] Failed to process activity reminder');
        errors++;

        // Progressive back-off and retry logic
        try {
          const currentMeta = reminder.metadata || {};
          const retryCount = (currentMeta.retry_count as number ?? 0) + 1;
          const lastError = err instanceof Error ? err.message : String(err);
          const newMeta = { ...currentMeta, retry_count: retryCount, last_error: lastError };

          if (retryCount < 3 && !(err instanceof ReminderNotificationUncertainError)) {
            const delayMinutes = retryCount === 1 ? 5 : 15;
            const newDueAt = new Date(Date.now() + delayMinutes * 60 * 1000);
            await this.updateActivityReminderDeliveryState(reminder.id,{
                reminderDueAt: newDueAt,
                status: 'pending',snoozedUntil: null,
                metadata: newMeta,
                lastSentAt: null, // Allow claiming again
                updatedAt: new Date(),
              });
            logger.info({ reminderId: reminder.id, retryCount, delayMinutes }, '[ReminderService] Scheduled activity reminder retry');
          } else {
            await this.updateActivityReminderDeliveryState(reminder.id,{
                status: 'failed',
                metadata: newMeta,
                updatedAt: new Date(),
              });

            // Trigger system alert via eventBus
            const { eventBus } = await import('../events/EventBus.js');
            await eventBus.publish({
              channel: 'events:notification' as never,
              userId: reminder.userId,
              timestamp: new Date().toISOString(),
              data: {
                type: 'reminder_delivery_failed',
                severity: 'critical',
                reminderId: reminder.id,
                title: `Reminder Delivery Failed: ${reminder.title || 'Activity Reminder'}`,
                message: `Failed to deliver reminder "${reminder.title || 'Activity Reminder'}" after 3 attempts. Error: ${lastError}`,
              },
            });
            logger.error({ reminderId: reminder.id }, '[ReminderService] Activity reminder failed permanently after max retries');
          }
        } catch (retryErr) {
          logger.error({ err: retryErr, reminderId: reminder.id }, '[ReminderService] Failed to handle activity reminder failure backoff');
        }
      }
    }

    // Process proposal reminders
    for (const reminder of proposalReminders) {
      if (!(await this.tryClaimReminder('proposal', reminder.id))) {
        continue;
      }
      try {
        const userResult = await db.execute(sql`
          SELECT u.email,p.title,p.recipient_email,p.lead_id,p.status AS proposal_status,p.valid_until,p.brand_toolkit_id,
            EXISTS (
              SELECT 1 FROM outreach_messages inbound
              WHERE inbound.conversation_id = p.outreach_conversation_id
                AND inbound.direction = 'inbound'
                AND inbound.created_at >= p.sent_at
            ) AS customer_replied
          FROM users u JOIN proposals p ON p.user_id=u.id
          WHERE u.id=${reminder.userId} AND p.id=${reminder.proposalId} LIMIT 1
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userEmail = (userResult.rows as any)?.[0]?.email;

        const details = userResult.rows?.[0];
        if (!details || ['accepted','rejected','expired'].includes(details.proposal_status) || (details.valid_until && new Date(details.valid_until).getTime() < Date.now())) {
          await db.update(proposalRemindersTable).set({status:'cancelled',updatedAt:new Date()}).where(eq(proposalRemindersTable.id,reminder.id));
          continue;
        }
        if (reminder.reminderType === 'customer_followup') {
          if (details.customer_replied) {
            await db.update(proposalRemindersTable).set({
              status: 'paused',
              lastSentAt: null,
              metadata: { ...reminder.metadata, pauseReason: 'customer_reply', pausedAt: new Date().toISOString() },
              updatedAt: new Date(),
            }).where(eq(proposalRemindersTable.id, reminder.id));
            continue;
          }
          if (!['sent','viewed'].includes(details.proposal_status) || !details.recipient_email) {
            await db.update(proposalRemindersTable).set({status:'cancelled',updatedAt:new Date()}).where(eq(proposalRemindersTable.id,reminder.id));
            continue;
          }
          const { emailService } = await import('./emailService.js');
          const reminderMetadata = reminder.metadata || {};
          const content = typeof reminderMetadata.message === 'string' && reminderMetadata.message.trim()
            ? reminderMetadata.message.trim()
            : `Please review our proposal "${details.title}" using the review link in the original proposal email. Reply if you have questions or need changes.`;
          const subject = typeof reminderMetadata.subject === 'string' && reminderMetadata.subject.trim()
            ? reminderMetadata.subject.trim()
            : `Following up: ${details.title}`;
          const result = await emailService.sendEmailWithUserCredentials(reminder.userId,{
            to:details.recipient_email,subject,text:content,html:`<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`,
            leadId:details.lead_id || undefined,idempotencyKey:`proposal-reminder:${reminder.id}`,isFollowUp:true,
            // The follow-up keeps the proposal's saved brand.
            brandToolkitId:details.brand_toolkit_id == null ? null : Number(details.brand_toolkit_id),
          });
          if (!result.success) throw new Error(result.error || 'Customer follow-up delivery failed');
        } else if (userEmail) {
          const delivery = await sendAdminEmail({
            to: userEmail,
            subject: `Proposal Reminder Due`,
            html: buildReminderEmailHtml({
              title: 'Proposal Reminder',
              description: `Your reminder for ${details.title || 'this proposal'} is due.`,
              contactName: null,
              contactEmail: null,
              dueAt: reminder.reminderDueAt,
              reminderType: reminder.reminderType,
            }),
          });
          if (!delivery.success) throw new Error(delivery.error || 'Owner reminder delivery failed');
        } else {
          throw new Error('Proposal owner email is missing');
        }

        await this.markReminderSent('proposal', reminder.id);
        processed++;
      } catch (err) {
        logger.error({ err, reminderId: reminder.id }, '[ReminderService] Failed to process proposal reminder');
        errors++;

        if (reminder.reminderType === 'customer_followup') {
          await db.update(proposalRemindersTable).set({status:'failed',metadata:{...reminder.metadata,last_error:String(err)},updatedAt:new Date()}).where(eq(proposalRemindersTable.id,reminder.id));
          continue;
        }

        // Progressive back-off and retry logic for proposal reminders
        try {
          const currentMeta = reminder.metadata || {};
          const retryCount = (currentMeta.retry_count as number ?? 0) + 1;
          const lastError = err instanceof Error ? err.message : String(err);
          const newMeta = { ...currentMeta, retry_count: retryCount, last_error: lastError };

          if (retryCount < 3) {
            const delayMinutes = retryCount === 1 ? 5 : 15;
            const newDueAt = new Date(Date.now() + delayMinutes * 60 * 1000);
            await db.update(proposalRemindersTable)
              .set({
                reminderDueAt: newDueAt,
                status: 'pending',snoozedUntil: null,
                metadata: newMeta,
                lastSentAt: null, // Allow claiming again
                updatedAt: new Date(),
              })
              .where(eq(proposalRemindersTable.id, reminder.id));
            logger.info({ reminderId: reminder.id, retryCount, delayMinutes }, '[ReminderService] Scheduled proposal reminder retry');
          } else {
            await db.update(proposalRemindersTable)
              .set({
                status: 'failed',
                metadata: newMeta,
                updatedAt: new Date(),
              })
              .where(eq(proposalRemindersTable.id, reminder.id));

            // Trigger system alert via eventBus
            const { eventBus } = await import('../events/EventBus.js');
            await eventBus.publish({
              channel: 'events:notification' as never,
              userId: reminder.userId,
              timestamp: new Date().toISOString(),
              data: {
                type: 'proposal_reminder_delivery_failed',
                severity: 'critical',
                reminderId: reminder.id,
                title: 'Proposal Reminder Delivery Failed',
                message: `Failed to deliver proposal reminder after 3 attempts. Error: ${lastError}`,
              },
            });
            logger.error({ reminderId: reminder.id }, '[ReminderService] Proposal reminder failed permanently after max retries');
          }
        } catch (retryErr) {
          logger.error({ err: retryErr, reminderId: reminder.id }, '[ReminderService] Failed to handle proposal reminder failure backoff');
        }
      }
    }

    if (processed > 0 || errors > 0) {
      logger.info({ processed, errors }, '[ReminderService] Due reminders processing complete');
    }

    return { processed, errors };
  }

}

export const reminderService = ReminderService.getInstance();

// ─── Email Template Helpers ─────────────────────────────────────────────────

// M19 — Escape HTML in user/contact-supplied fields before injecting into
// email templates. Reminder titles/descriptions/contact names come from CRM
// inputs that may contain `<script>` or other HTML.
function esc(input: string | null | undefined): string {
  if (!input) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function buildReminderEmailHtml(data: {
  title: string;
  description: string;
  contactName: string | null;
  contactEmail: string | null;
  dueAt: Date;
  reminderType: string;
}): string {
  const typeLabel = data.reminderType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return renderAdminEmail({
    title: `🔔 ${esc(data.title)}`,
    preheader: esc(data.description),
    content: `
      <div style="background: #f8fafc; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0; margin-bottom: 20px;">
        <p style="margin: 0 0 16px; color: #64748b; font-size: 14px;">Type: <strong>${esc(typeLabel)}</strong></p>
        ${data.description ? `<p style="margin: 0 0 16px; color: #334155; font-size: 14px; line-height: 1.6;">${esc(data.description)}</p>` : ''}
        ${data.contactName ? `<p style="margin: 0 0 4px; color: #475569; font-size: 13px;">Contact: <strong>${esc(data.contactName)}</strong>${data.contactEmail ? ` (${esc(data.contactEmail)})` : ''}</p>` : ''}
        <p style="margin: 16px 0 0; color: #64748b; font-size: 12px;">Due: ${esc(data.dueAt.toLocaleString())}</p>
      </div>
    `,
    footer: 'Sent by AskSales.ai Platform'
  });
}

function buildContactNotificationHtml(data: {
  title: string;
  description: string;
  reminderType: string;
  contactName: string | null;
  senderName: string;
  brand?: { companyName: string; logoUrl: string | null; primaryColor: string };
}): string {
  const typeMessages: Record<string, string> = {
    proposal_sent: 'We have sent you a proposal. Please review it at your convenience.',
    ticket_open: 'A support ticket has been opened for your request. We will be in touch shortly.',
    ticket_close: 'Your support ticket has been resolved. Please let us know if you need further assistance.',
    meeting: 'This is a reminder about our upcoming meeting.',
  };
  const body = typeMessages[data.reminderType] || data.description || 'This is a notification from our team.';

  if (data.brand) {
    return renderBrandedEmail({
      brand: data.brand,
      preheader: esc(data.title) || 'Notification',
      recipientName: data.contactName || undefined,
      body: `<p style="margin:0 0 16px;line-height:1.6;color:#334155;">${esc(body)}</p>`,
      footerText: `Best regards, ${data.senderName}`,
    });
  }

  return renderAdminEmail({
    title: esc(data.title) || 'Notification',
    preheader: esc(body),
    name: data.contactName || undefined,
    content: esc(body),
    footer: `Best regards,<br/>${esc(data.senderName)}`
  });
}

function getContactEmailSubject(reminderType: string, title: string | null): string {
  const subjects: Record<string, string> = {
    proposal_sent: 'New Proposal for Your Review',
    ticket_open: 'Support Ticket Opened',
    ticket_close: 'Support Ticket Resolved',
    meeting: 'Meeting Reminder',
  };
  return subjects[reminderType] || title || 'Notification';
}
