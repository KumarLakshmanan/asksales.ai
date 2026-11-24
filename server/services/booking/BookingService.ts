import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../utils/timezone.js';
import {
  getHotelPaymentConfiguration,
  getPaymentProviderForUser,
  isMockPaymentAllowed,
} from './PaymentProvider.js';
import type { BookingDraft, BookingRecord } from './types.js';
import { recordPaymentEvidence, type PaymentEvidence } from '../insights/SalesEvidence.js';
import { confirmationRecoveryFor, type ConfirmationRecovery } from './ConfirmationRecovery.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { isEmailAddress } from '../../../shared/emailAddress.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOLD_MINUTES = 30;

type SqlExecutor = {
  execute: (query: unknown) => Promise<{ rows: unknown[] }>;
};

interface ConfirmationTransactionResult {
  booking: BookingRecord;
  newlyConfirmed: boolean;
  expired?: boolean;
}

export interface BookingPaymentReceipt {
  amountMinor: number;
  currency: string;
  paymentId?: string;
  source: PaymentEvidence['source'];
  occurredAt: string;
}

export class BookingLifecycleError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
    readonly bookingId?: number,
  ) {
    super(message);
    this.name = 'BookingLifecycleError';
  }
}

function parseDate(value: string): number | null {
  if (!DATE_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    return null;
  }
  return timestamp;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = parseDate(checkIn);
  const end = parseDate(checkOut);
  if (start === null || end === null || end <= start) return 0;
  return Math.round((end - start) / DAY_MS);
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function optionalIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function positiveInteger(value: unknown, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function positiveMoney(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100_000_000
    ? Number(parsed.toFixed(2))
    : null;
}

function buildIdempotencyKey(draft: BookingDraft): string {
  const identity = draft.conversationId
    ? `conversation:${draft.conversationId}`
    : draft.leadId
      ? `lead:${draft.leadId}`
      : `guest:${String(draft.guestPhone || draft.guestEmail || draft.guestName || 'anonymous').trim().toLowerCase()}`;
  return crypto.createHash('sha256')
    .update([
      draft.userId,
      identity,
      draft.roomTypeId,
      draft.checkIn,
      draft.checkOut,
      draft.rooms,
    ].join('|'))
    .digest('hex');
}

export async function hasAnyPaymentMethodEnabled(userId: number): Promise<boolean> {
  try {
    const config = await getHotelPaymentConfiguration(userId);
    if (!config.paymentMethodsEnabled) return false;
    const methods = config.methods;
    const online = methods.online?.enabled === true
      && (
        (config.provider === 'razorpay' && !!config.keyId && !!config.keySecret && !!config.webhookSecret)
        || (config.provider === 'mock' && isMockPaymentAllowed())
      );
    return Boolean(
      online
      || (methods.upiQr?.enabled && methods.upiQr.upiId)
      || (methods.bankTransfer?.enabled && methods.bankTransfer.accountNumber && methods.bankTransfer.ifscCode)
      || (methods.customLink?.enabled && methods.customLink.url)
      || (methods.manual?.enabled && methods.manual.instructions),
    );
  } catch (error) {
    logger.error({ err: error, userId }, '[BookingService] Failed to resolve payment readiness');
    return false;
  }
}

export class BookingService {
  async createBooking(
    draft: BookingDraft,
  ): Promise<
    | { booking: BookingRecord; paymentUrl: string }
    | { error: string; code?: 'external_booking_required' | 'payment_configuration_unavailable' }
  > {
    const validationError = this.validateDraft(draft);
    if (validationError) return { error: validationError };

    // This guard deliberately sits before the transaction and inventory hold.
    // It protects legacy, compatibility, and Mastra callers as well as the
    // support-agent tool path when the owner has selected external checkout.
    try {
      const paymentConfig = await getHotelPaymentConfiguration(draft.userId);
      if (!paymentConfig.paymentMethodsEnabled) {
        const existingKey = buildIdempotencyKey(draft);
        const existingRows = await db.execute(sql`
          SELECT *
          FROM bookings
          WHERE user_id = ${draft.userId}
            AND idempotency_key = ${existingKey}
            AND (
              status = 'confirmed'
              OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > NOW()))
            )
          ORDER BY id DESC
          LIMIT 1
        `);
        const existing = (existingRows.rows as Array<Record<string, unknown>>)[0];
        if (existing) {
          const booking = this.toRecord(existing);
          return { booking, paymentUrl: booking.paymentLink || '' };
        }
        return {
          error: paymentConfig.externalBooking.url
            ? 'This property completes new bookings on its external booking page.'
            : 'External booking mode is active, but its booking page is not configured.',
          code: 'external_booking_required',
        };
      }
    } catch (error) {
      logger.error({ err: error, userId: draft.userId }, '[BookingService] Payment mode lookup failed');
      return {
        error: 'Unable to verify the property booking mode. No booking or inventory hold was created.',
        code: 'payment_configuration_unavailable',
      };
    }

    const rooms = positiveInteger(draft.rooms, 100)!;
    const guests = positiveInteger(draft.guests, 500)!;
    const agreedNightlyPrice = draft.agreedPricePerNight === undefined
      ? null
      : positiveMoney(draft.agreedPricePerNight);
    const agreedTotalPrice = draft.agreedTotalPrice === undefined
      ? null
      : positiveMoney(draft.agreedTotalPrice);
    const nights = nightsBetween(draft.checkIn, draft.checkOut);
    const idempotencyKey = buildIdempotencyKey(draft);
    const advisoryKey = (Number.parseInt(idempotencyKey.slice(0, 8), 16) | 0);

    try {
      const held = await db.transaction(async (tx: SqlExecutor): Promise<BookingRecord> => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${draft.userId}, ${advisoryKey})`);

        const existingRows = await tx.execute(sql`
          SELECT *
          FROM bookings
          WHERE idempotency_key = ${idempotencyKey}
            AND status IN ('pending_payment', 'confirmed')
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE
        `);
        const existing = (existingRows.rows as Array<Record<string, unknown>>)[0];
        if (existing) {
          const expired = existing.status === 'pending_payment'
            && existing.hold_expires_at
            && new Date(String(existing.hold_expires_at)).getTime() <= Date.now();
          if (!expired) return this.toRecord(existing);
          await this.releaseInventory(tx, existing, 'expired', 'Payment hold expired before checkout.');
        }

        const roomRows = await tx.execute(sql`
          SELECT
            rt.id,
            rt.hotel_id,
            rt.name,
            rt.capacity,
            rt.base_price,
            rt.min_price,
            rt.max_discount_pct,
            hp.currency,
            hp.timezone
          FROM room_types rt
          JOIN hotel_properties hp ON hp.id = rt.hotel_id
          WHERE rt.id = ${draft.roomTypeId}
            AND hp.user_id = ${draft.userId}
          LIMIT 1
          FOR UPDATE OF rt, hp
        `);
        const room = (roomRows.rows as Array<Record<string, unknown>>)[0];
        if (!room) throw new BookingLifecycleError('Selected room type was not found.', 404);
        if (Number(room.capacity) * rooms < guests) {
          throw new BookingLifecycleError('The selected room capacity is too small for this guest count.', 400);
        }

        const inventoryRows = await tx.execute(sql`
          SELECT date, available_count, total_count, price_per_night
          FROM room_availability
          WHERE room_type_id = ${draft.roomTypeId}
            AND date >= ${draft.checkIn}::date
            AND date < ${draft.checkOut}::date
          ORDER BY date
          FOR UPDATE
        `);
        const inventory = inventoryRows.rows as Array<Record<string, unknown>>;
        if (inventory.length !== nights || inventory.some((row) => Number(row.available_count) < rooms)) {
          throw new BookingLifecycleError('Selected room type is no longer available for every night of the stay.');
        }

        const baseTotal = Number(
          (inventory.reduce((sum, row) => sum + Number(row.price_per_night), 0) * rooms).toFixed(2),
        );
        const nightlyFloors = inventory.map((row) => Math.max(
          Number(room.min_price),
          Number((Number(row.price_per_night) * (1 - Number(room.max_discount_pct) / 100)).toFixed(2)),
        ));
        const configuredFloorTotal = Number(
          (nightlyFloors.reduce((sum, floor) => sum + floor, 0) * rooms).toFixed(2),
        );
        let storedAgreedNightly: number;
        let totalPrice: number;
        if (agreedTotalPrice !== null) {
          if (agreedTotalPrice < configuredFloorTotal) {
            throw new BookingLifecycleError(
              `The agreed stay total is below the configured floor of ${room.currency} ${configuredFloorTotal.toFixed(2)}.`,
              409,
            );
          }
          totalPrice = agreedTotalPrice;
          storedAgreedNightly = Number((agreedTotalPrice / (nights * rooms)).toFixed(2));
        } else {
          const highestNightlyFloor = Math.max(...nightlyFloors);
          if (agreedNightlyPrice === null || agreedNightlyPrice < highestNightlyFloor) {
            throw new BookingLifecycleError(
              `The agreed nightly price is below the configured floor of ${room.currency} ${highestNightlyFloor.toFixed(2)}.`,
              409,
            );
          }
          storedAgreedNightly = agreedNightlyPrice;
          totalPrice = Number((agreedNightlyPrice * nights * rooms).toFixed(2));
        }
        const holdMinutes = Math.min(
          Math.max(Number(process.env.BOOKING_HOLD_MINUTES || DEFAULT_HOLD_MINUTES), 5),
          24 * 60,
        );

        await tx.execute(sql`
          UPDATE room_availability
          SET available_count = available_count - ${rooms},
              updated_at = NOW()
          WHERE room_type_id = ${draft.roomTypeId}
            AND date >= ${draft.checkIn}::date
            AND date < ${draft.checkOut}::date
            AND available_count >= ${rooms}
        `);

        const inserted = await tx.execute(sql`
          INSERT INTO bookings (
            user_id, lead_id, outreach_conversation_id, hotel_property_id, room_type_id,
            guest_name, guest_email, guest_phone,
            check_in_date, check_out_date, nights, number_of_guests, number_of_rooms,
            base_total, agreed_price_per_night, total_price, currency,
            status, payment_status, special_requests, idempotency_key,
            inventory_reserved_at, hold_expires_at
          ) VALUES (
            ${draft.userId}, ${draft.leadId ?? null}, ${draft.conversationId ?? null},
            ${Number(room.hotel_id)}, ${draft.roomTypeId},
            ${draft.guestName?.trim().slice(0, 255) || null},
            ${draft.guestEmail?.trim().toLowerCase().slice(0, 255) || null},
            ${draft.guestPhone?.trim().slice(0, 40) || null},
            ${draft.checkIn}::date, ${draft.checkOut}::date, ${nights}, ${guests}, ${rooms},
            ${baseTotal}, ${storedAgreedNightly}, ${totalPrice}, ${String(room.currency || 'INR').toUpperCase()},
            'pending_payment', 'pending', ${draft.specialRequests?.trim().slice(0, 4000) || null},
            ${idempotencyKey}, NOW(), NOW() + (${holdMinutes} * INTERVAL '1 minute')
          )
          RETURNING *
        `);
        return this.toRecord((inserted.rows as Array<Record<string, unknown>>)[0]);
      });

      if (held.status === 'confirmed') return { booking: held, paymentUrl: held.paymentLink || '' };
      if (held.paymentLink) return { booking: held, paymentUrl: held.paymentLink };

      const paymentConfig = await getHotelPaymentConfiguration(draft.userId);
      const methods = paymentConfig.methods;
      if (methods.online?.enabled === true) {
        const provider = await getPaymentProviderForUser(draft.userId);
        if (!provider) {
          await this.cancelBookingById(
            held.id,
            draft.userId,
            'Payment provider configuration is incomplete.',
          );
          return {
            error: paymentConfig.provider === 'mock' && !isMockPaymentAllowed()
              ? 'Mock payments are disabled in production. Configure Razorpay or another manual payment method.'
              : 'The online payment provider is not ready. Configure valid credentials and a webhook secret.',
          };
        }

        const claimed = await this.claimPaymentLink(held.id);
        if (!claimed) {
          const current = await this.getById(held.id, draft.userId);
          return current?.paymentLink
            ? { booking: current, paymentUrl: current.paymentLink }
            : { error: 'A payment link is already being prepared. Please retry in a moment.' };
        }

        try {
          const link = await provider.createPaymentLink(held, {
            customerName: draft.guestName ?? undefined,
            customerPhone: draft.guestPhone ?? undefined,
            customerEmail: draft.guestEmail ?? undefined,
          });
          const updated = await db.execute(sql`
            UPDATE bookings
            SET payment_provider = ${link.provider},
                payment_ref = ${link.ref},
                payment_link = ${link.url},
                payment_link_claimed_at = NULL,
                payment_link_error = NULL,
                updated_at = NOW()
            WHERE id = ${held.id}
              AND user_id = ${draft.userId}
              AND status = 'pending_payment'
            RETURNING *
          `);
          const booking = (updated.rows as Array<Record<string, unknown>>)[0];
          if (!booking) throw new BookingLifecycleError('The booking hold expired while creating its payment link.');
          const record = this.toRecord(booking);
          return { booking: record, paymentUrl: link.url };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to create payment link.';
          await db.execute(sql`
            UPDATE bookings
            SET payment_link_claimed_at = NULL,
                payment_link_error = ${message.slice(0, 1000)},
                updated_at = NOW()
            WHERE id = ${held.id} AND user_id = ${draft.userId}
          `);
          await this.cancelBookingById(held.id, draft.userId, 'Payment link creation failed.');
          return { error: message };
        }
      }

      const customUrl = methods.customLink?.enabled ? this.safeHttpsUrl(methods.customLink.url) : null;
      if (methods.customLink?.enabled && !customUrl) {
        await this.cancelBookingById(
          held.id,
          draft.userId,
          'The configured custom payment link is invalid.',
        );
        return {
          error: 'The custom payment link is not ready. Configure a credential-free HTTPS URL.',
        };
      }
      if (customUrl) {
        await db.execute(sql`
          UPDATE bookings
          SET payment_provider = 'custom',
              payment_link = ${customUrl},
              updated_at = NOW()
          WHERE id = ${held.id} AND user_id = ${draft.userId}
        `);
        return {
          booking: { ...held, paymentProvider: 'custom', paymentLink: customUrl },
          paymentUrl: customUrl,
        };
      }

      const manualPaymentEnabled = Boolean(
        (methods.upiQr?.enabled && methods.upiQr.upiId)
        || (methods.bankTransfer?.enabled && methods.bankTransfer.accountNumber && methods.bankTransfer.ifscCode)
        || (methods.manual?.enabled && methods.manual.instructions),
      );
      if (manualPaymentEnabled) return { booking: held, paymentUrl: '' };

      const confirmed = await this.confirmBookingById(held.id, draft.userId, 'no_payment_required');
      if (!confirmed) return { error: 'Unable to finalize the booking.' };
      return { booking: confirmed, paymentUrl: '' };
    } catch (error) {
      logger.warn({ err: error, userId: draft.userId }, '[BookingService] Booking creation rejected');
      return {
        error: error instanceof BookingLifecycleError
          ? error.message
          : 'Unable to create the booking. Please recheck availability and try again.',
      };
    }
  }

  async hasAnyPaymentMethodEnabled(userId: number): Promise<boolean> {
    return hasAnyPaymentMethodEnabled(userId);
  }

  async confirmBooking(paymentRef: string, paymentId?: string, receipt?: BookingPaymentReceipt): Promise<BookingRecord | null> {
    if (!paymentRef || paymentRef.length > 255) return null;
    try {
      const result = await this.confirmTransaction({ paymentRef, paymentId, receipt, source: 'provider_webhook' });
      if (!result) return null;
      await this.processConfirmationSideEffects(result.booking.id);
      return result.booking;
    } catch (error) {
      if (error instanceof BookingLifecycleError && paymentId && error.bookingId) {
        await db.execute(sql`
          UPDATE bookings
          SET payment_status = 'refund_pending',
              payment_id = ${paymentId},
              metadata = COALESCE(metadata, '{}'::jsonb)
                || ${JSON.stringify({ latePaymentReceivedAt: new Date().toISOString() })}::jsonb,
              updated_at = NOW()
          WHERE id = ${error.bookingId}
            AND payment_status IS DISTINCT FROM 'refunded'
            AND (payment_id IS NULL OR payment_id = ${paymentId})
        `);
      }
      throw error;
    }
  }

  async confirmBookingById(
    bookingId: number,
    userId?: number,
    source = 'manual_dashboard',
    receipt?: BookingPaymentReceipt,
  ): Promise<BookingRecord | null> {
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) return null;
    const result = await this.confirmTransaction({ bookingId, userId, source, receipt, paymentId: receipt?.paymentId });
    if (!result) return null;
    await this.processConfirmationSideEffects(result.booking.id);
    return result.booking;
  }

  async getConfirmationRecovery(bookingId: number, userId: number): Promise<ConfirmationRecovery | null> {
    const scope = currentBusinessScope();
    if (!scope || scope.userId !== userId) throw new BookingLifecycleError('A matching business scope is required.', 403);
    const result = await db.execute(sql`SELECT status, metadata, side_effects_processed_at,
      (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS recovery_clock_ms
      FROM bookings WHERE id = ${bookingId} AND user_id = ${userId} AND business_profile_id = ${scope.businessProfileId} LIMIT 1`);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? confirmationRecoveryFor(row, Number(row.recovery_clock_ms)) : null;
  }

  /** Resume existing setup only. No confirmation/payment mutation or guest send. */
  async retryConfirmationRecovery(bookingId: number, userId: number): Promise<ConfirmationRecovery | null> {
    const current = await this.getConfirmationRecovery(bookingId, userId);
    if (!current) return null;
    if (current.state === 'not_applicable') throw new BookingLifecycleError('Only confirmed bookings have confirmation setup to recover.', 409);
    if (current.canRetry) await this.processConfirmationSideEffects(bookingId);
    return this.getConfirmationRecovery(bookingId, userId);
  }

  async cancelBookingById(
    bookingId: number,
    userId: number,
    reason: string,
  ): Promise<BookingRecord | null> {
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) return null;
    const cleanReason = String(reason || '').trim().slice(0, 1000);
    if (!cleanReason) throw new BookingLifecycleError('A cancellation reason is required.', 400);

    const booking = await db.transaction(async (tx: SqlExecutor): Promise<BookingRecord | null> => {
      const rows = await tx.execute(sql`
        SELECT *
        FROM bookings
        WHERE id = ${bookingId} AND user_id = ${userId}
        LIMIT 1
        FOR UPDATE
      `);
      const row = (rows.rows as Array<Record<string, unknown>>)[0];
      if (!row) return null;
      if (row.status === 'cancelled' || row.status === 'expired') return this.toRecord(row);
      if (row.status !== 'pending_payment' && row.status !== 'confirmed') {
        throw new BookingLifecycleError(`A booking in ${row.status} status cannot be cancelled.`);
      }
      return this.releaseInventory(tx, row, 'cancelled', cleanReason);
    });

    if (booking) await this.cancelConfirmationReminders(bookingId, userId);
    return booking;
  }

  /** Reflect verified ledger totals after a processed refund, including replay.
   * This does not request a provider refund or change the reservation status. */
  async reconcileRefundStatus(bookingId: number, userId: number): Promise<void> {
    await db.transaction(async (tx: SqlExecutor) => {
      const rows = await tx.execute(sql`SELECT id, status, payment_id FROM bookings
        WHERE id = ${bookingId} AND user_id = ${userId} FOR UPDATE`);
      const booking = rows.rows[0] as Record<string, unknown> | undefined;
      if (!booking?.payment_id) return;
      const totals = await tx.execute(sql`SELECT
        COALESCE(SUM(amount) FILTER (WHERE kind = 'payment_captured'), 0) AS captured,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'payment_refunded'), 0) AS refunded
        FROM sales_outcome_events WHERE booking_id = ${bookingId}
          AND payment_id = ${String(booking.payment_id)} AND verified = true`);
      const total = totals.rows[0] as { captured: string; refunded: string };
      if (Number(total.captured) <= 0 || Number(total.refunded) <= 0) return;
      const paymentStatus = Number(total.refunded) >= Number(total.captured)
        ? 'refunded'
        : booking.status === 'cancelled' || booking.status === 'expired'
          ? 'refund_pending' : 'partially_refunded';
      await tx.execute(sql`UPDATE bookings SET payment_status = ${paymentStatus}, updated_at = NOW()
        WHERE id = ${bookingId} AND user_id = ${userId}`);
    });
  }

  async releaseExpiredHolds(limit = 100): Promise<{ expired: number }> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    return db.transaction(async (tx: SqlExecutor) => {
      const rows = await tx.execute(sql`
        SELECT *
        FROM bookings
        WHERE status = 'pending_payment'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at <= NOW()
          AND inventory_released_at IS NULL
        ORDER BY hold_expires_at
        LIMIT ${boundedLimit}
        FOR UPDATE SKIP LOCKED
      `);
      let expired = 0;
      for (const row of rows.rows as Array<Record<string, unknown>>) {
        await this.releaseInventory(tx, row, 'expired', 'Payment hold expired.');
        expired += 1;
      }
      return { expired };
    });
  }

  async claimConfirmationNotification(bookingId: number): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE bookings
      SET confirmation_notification_claimed_at = NOW()
      WHERE id = ${bookingId}
        AND status = 'confirmed'
        AND confirmation_notified_at IS NULL
        AND (
          confirmation_notification_claimed_at IS NULL
          OR confirmation_notification_claimed_at < NOW() - INTERVAL '10 minutes'
        )
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  async completeConfirmationNotification(bookingId: number, sent: boolean): Promise<void> {
    await db.execute(sent
      ? sql`
          UPDATE bookings
          SET confirmation_notified_at = NOW(),
              confirmation_notification_claimed_at = NULL,
              updated_at = NOW()
          WHERE id = ${bookingId}
        `
      : sql`
          UPDATE bookings
          SET confirmation_notification_claimed_at = NULL,
              updated_at = NOW()
          WHERE id = ${bookingId}
        `);
  }

  async getByConversation(conversationId: number, userId?: number): Promise<BookingRecord[]> {
    const rows = await db.execute(sql`
      SELECT *
      FROM bookings
      WHERE outreach_conversation_id = ${conversationId}
        ${userId ? sql`AND user_id = ${userId}` : sql``}
      ORDER BY created_at DESC
      LIMIT 100
    `);
    return (rows.rows as Array<Record<string, unknown>>).map((row) => this.toRecord(row));
  }

  async getById(bookingId: number, userId: number): Promise<BookingRecord | null> {
    const rows = await db.execute(sql`
      SELECT * FROM bookings WHERE id = ${bookingId} AND user_id = ${userId} LIMIT 1
    `);
    const row = (rows.rows as Array<Record<string, unknown>>)[0];
    return row ? this.toRecord(row) : null;
  }

  private validateDraft(draft: BookingDraft): string | null {
    if (!Number.isSafeInteger(draft.userId) || draft.userId <= 0) return 'A valid account is required.';
    if (!Number.isSafeInteger(draft.roomTypeId) || draft.roomTypeId <= 0) return 'A valid room type is required.';
    if (!positiveInteger(draft.rooms, 100)) return 'Rooms must be between 1 and 100.';
    if (!positiveInteger(draft.guests, 500)) return 'Guests must be between 1 and 500.';
    if (
      draft.agreedPricePerNight === undefined
      && draft.agreedTotalPrice === undefined
    ) return 'An agreed nightly price or stay total is required.';
    if (
      draft.agreedPricePerNight !== undefined
      && !positiveMoney(draft.agreedPricePerNight)
    ) return 'The agreed nightly price must be positive.';
    if (
      draft.agreedTotalPrice !== undefined
      && !positiveMoney(draft.agreedTotalPrice)
    ) return 'The agreed stay total must be positive.';
    const nights = nightsBetween(draft.checkIn, draft.checkOut);
    if (nights <= 0 || nights > 365) return 'Check-out must be after check-in and the stay cannot exceed 365 nights.';
    if (draft.guestEmail && !isEmailAddress(draft.guestEmail)) {
      return 'The guest email address is invalid.';
    }
    return null;
  }

  private async confirmTransaction(input: {
    bookingId?: number;
    paymentRef?: string;
    paymentId?: string;
    userId?: number;
    source: string;
    receipt?: BookingPaymentReceipt;
  }): Promise<ConfirmationTransactionResult | null> {
    const result = await db.transaction(async (tx: SqlExecutor): Promise<ConfirmationTransactionResult | null> => {
      const rows = await tx.execute(sql`
        SELECT *
        FROM bookings
        WHERE ${input.bookingId ? sql`id = ${input.bookingId}` : sql`payment_ref = ${input.paymentRef!}`}
          ${input.userId ? sql`AND user_id = ${input.userId}` : sql``}
        LIMIT 1
        FOR UPDATE
      `);
      const booking = (rows.rows as Array<Record<string, unknown>>)[0];
      if (!booking) return null;
      if (input.receipt && (!input.paymentId || !input.receipt.occurredAt
        || !['manual', 'razorpay'].includes(input.receipt.source))) {
        throw new BookingLifecycleError('Captured payment evidence is incomplete.', 400);
      }
      // Validate evidence under the booking lock BEFORE the durable state change
      // and CRM effects. A signed event may still describe a partial or foreign
      // payment, and a replay must retain its original payment identity.
      if (input.receipt && (
        !Number.isSafeInteger(input.receipt.amountMinor)
        || input.receipt.amountMinor <= 0
        || input.receipt.amountMinor !== Math.round(Number(booking.total_price) * 100)
        || input.receipt.currency.toUpperCase() !== String(booking.currency).toUpperCase()
      )) {
        throw new BookingLifecycleError('Payment amount or currency does not match this booking.', 400);
      }
      if (input.paymentId && booking.payment_id && input.paymentId !== booking.payment_id) {
        throw new BookingLifecycleError('A different payment is already attached to this booking.', 409);
      }
      if (booking.status === 'confirmed') {
        await this.persistConfirmationEvidence(tx, Number(booking.id), input);
        return { booking: this.toRecord(booking), newlyConfirmed: false };
      }
      if (booking.status === 'cancelled' || booking.status === 'expired') {
        throw new BookingLifecycleError(
          'This booking hold is no longer active. The payment requires reconciliation or refund.',
          409,
          Number(booking.id),
        );
      }
      if (booking.status !== 'pending_payment') {
        throw new BookingLifecycleError(`A booking in ${booking.status} status cannot be confirmed.`);
      }

      // Check the database clock AFTER obtaining the booking lock. A request
      // queued before the deadline can acquire that lock after the hold expires.
      const deadline = booking.hold_expires_at
        ? await tx.execute(sql`SELECT ${booking.hold_expires_at}::timestamptz <= clock_timestamp() AS expired`)
        : null;
      if ((deadline?.rows[0] as { expired?: boolean } | undefined)?.expired) {
        // Commit the release before reporting a stale approval. Throwing inside
        // this transaction would roll back expiry and leave stock reserved.
        const expired = await this.releaseInventory(tx, booking, 'expired', 'Payment hold expired before confirmation.');
        return { booking: expired, newlyConfirmed: false, expired: true };
      }

      const alreadyReserved = Boolean(booking.inventory_reserved_at) && !booking.inventory_released_at;
      if (!alreadyReserved) {
        const checkIn = dateOnly(booking.check_in_date);
        const checkOut = dateOnly(booking.check_out_date);
        const nights = nightsBetween(checkIn, checkOut);
        const inventoryRows = await tx.execute(sql`
          SELECT date, available_count
          FROM room_availability
          WHERE room_type_id = ${Number(booking.room_type_id)}
            AND date >= ${checkIn}::date
            AND date < ${checkOut}::date
          ORDER BY date
          FOR UPDATE
        `);
        const inventory = inventoryRows.rows as Array<Record<string, unknown>>;
        const rooms = Number(booking.number_of_rooms);
        if (inventory.length !== nights || inventory.some((row) => Number(row.available_count) < rooms)) {
          throw new BookingLifecycleError(
            'Inventory is no longer available. Do not capture payment; select another room or dates.',
          );
        }
        await tx.execute(sql`
          UPDATE room_availability
          SET available_count = available_count - ${rooms}, updated_at = NOW()
          WHERE room_type_id = ${Number(booking.room_type_id)}
            AND date >= ${checkIn}::date
            AND date < ${checkOut}::date
        `);
      }

      const updated = await tx.execute(sql`
        UPDATE bookings
        SET status = 'confirmed',
            payment_status = 'paid',
            payment_id = COALESCE(${input.paymentId || null}, payment_id),
            inventory_reserved_at = COALESCE(inventory_reserved_at, NOW()),
            inventory_released_at = NULL,
            hold_expires_at = NULL,
            confirmed_at = COALESCE(confirmed_at, NOW()),
            metadata = COALESCE(metadata, '{}'::jsonb)
              || ${JSON.stringify({
                confirmationSource: input.source,
                confirmedAt: new Date().toISOString(),
              })}::jsonb,
            updated_at = NOW()
        WHERE id = ${Number(booking.id)}
        RETURNING *
      `);
      const confirmed = (updated.rows as Array<Record<string, unknown>>)[0];
      // Evidence rejection must roll back confirmation and any inventory debit.
      // No CRM or notification work runs until this transaction has committed.
      await this.persistConfirmationEvidence(tx, Number(confirmed.id), input);
      logger.info(
        { bookingId: booking.id, source: input.source },
        '[BookingService] Booking confirmed with reserved inventory',
      );
      return { booking: this.toRecord(confirmed), newlyConfirmed: true };
    });
    if (result?.expired) {
      throw new BookingLifecycleError(
        'This booking hold is no longer active. The payment requires reconciliation or refund.',
        409,
        result.booking.id,
      );
    }
    return result;
  }

  private async persistConfirmationEvidence(tx: SqlExecutor, bookingId: number, input: {
    paymentId?: string;
    receipt?: BookingPaymentReceipt;
  }): Promise<void> {
    const receipt = input.receipt;
    if (!receipt) return; // Existing explicit manual/no-payment policy.
    if (!input.paymentId || !receipt.occurredAt || !['manual', 'razorpay'].includes(receipt.source)) {
      throw new BookingLifecycleError('Captured payment evidence is incomplete.', 400);
    }
    await recordPaymentEvidence({
      bookingId, paymentId: input.paymentId, amountMinor: receipt.amountMinor,
      currency: receipt.currency.toUpperCase(), occurredAt: receipt.occurredAt,
      source: receipt.source,
    }, tx);
  }

  private async releaseInventory(
    tx: SqlExecutor,
    booking: Record<string, unknown>,
    status: 'cancelled' | 'expired',
    reason: string,
  ): Promise<BookingRecord> {
    const hasReservation = Boolean(booking.inventory_reserved_at) && !booking.inventory_released_at;
    if (hasReservation) {
      const checkIn = dateOnly(booking.check_in_date);
      const checkOut = dateOnly(booking.check_out_date);
      const rooms = Number(booking.number_of_rooms);
      await tx.execute(sql`
        SELECT id
        FROM room_availability
        WHERE room_type_id = ${Number(booking.room_type_id)}
          AND date >= ${checkIn}::date
          AND date < ${checkOut}::date
        FOR UPDATE
      `);
      await tx.execute(sql`
        UPDATE room_availability
        SET available_count = LEAST(total_count, available_count + ${rooms}),
            updated_at = NOW()
        WHERE room_type_id = ${Number(booking.room_type_id)}
          AND date >= ${checkIn}::date
          AND date < ${checkOut}::date
      `);
    }

    const paid = ['paid', 'partially_refunded', 'refund_pending'].includes(String(booking.payment_status));
    const updated = await tx.execute(sql`
      UPDATE bookings
      SET status = ${status},
          payment_status = ${booking.payment_status === 'refunded' ? 'refunded' : paid ? 'refund_pending' : status === 'expired' ? 'expired' : 'cancelled'},
          inventory_released_at = COALESCE(inventory_released_at, NOW()),
          hold_expires_at = NULL,
          cancelled_at = COALESCE(cancelled_at, NOW()),
          cancellation_reason = ${reason},
          updated_at = NOW()
      WHERE id = ${Number(booking.id)}
      RETURNING *
    `);
    return this.toRecord((updated.rows as Array<Record<string, unknown>>)[0]);
  }

  private async claimPaymentLink(bookingId: number): Promise<boolean> {
    const result = await db.execute(sql`
      UPDATE bookings
      SET payment_link_claimed_at = NOW(), updated_at = NOW()
      WHERE id = ${bookingId}
        AND status = 'pending_payment'
        AND payment_link IS NULL
        AND (
          payment_link_claimed_at IS NULL
          OR payment_link_claimed_at < NOW() - INTERVAL '2 minutes'
        )
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  private async cancelConfirmationReminders(bookingId: number, userId: number): Promise<void> {
    await db.execute(sql`
      UPDATE crm_activity_reminders SET status = 'cancelled', updated_at = NOW()
      WHERE user_id = ${userId} AND status = 'pending'
        AND metadata->>'bookingId' = ${String(bookingId)}
    `).catch((error: unknown) => {
      logger.warn({ err: error, bookingId }, '[BookingService] Failed to cancel booking reminders');
    });
  }

  private async updateConfirmationRecovery(
    bookingId: number,
    claimToken: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const updated = await db.execute(sql`
      UPDATE bookings SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
        '{hotelConfirmationRecovery}',
        COALESCE(metadata->'hotelConfirmationRecovery', '{}'::jsonb)
          || ${JSON.stringify(patch)}::jsonb
          || jsonb_build_object('claimExpiresAtMs', (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000)),
        updated_at = NOW()
      WHERE id = ${bookingId} AND status = 'confirmed'
        AND metadata->'hotelConfirmationRecovery'->>'claimToken' = ${claimToken}
      RETURNING id
    `);
    if (!updated.rows.length) throw new Error('Confirmation recovery claim is no longer active.');
  }

  private async processConfirmationSideEffects(bookingId: number): Promise<void> {
    const claimToken = crypto.randomUUID();
    // A short atomic lease avoids holding a pooled transaction while calling
    // shared helpers. Per-step markers survive a failure or process restart.
    // Legacy completion markers cannot establish whether an alert was sent;
    // recover idempotent CRM/reminder work without re-emitting that alert.
    const claimed = await db.execute(sql`
      UPDATE bookings SET
        metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{hotelConfirmationRecovery}',
          CASE WHEN jsonb_typeof(metadata->'hotelConfirmationRecovery') = 'object'
            THEN metadata->'hotelConfirmationRecovery' ELSE '{}'::jsonb END
          || jsonb_build_object('version', 1, 'claimToken', ${claimToken}::text,
            'claimExpiresAtMs', (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
            'alertDispatch', CASE WHEN side_effects_processed_at IS NOT NULL
              AND metadata->'hotelConfirmationRecovery'->>'version' IS NULL THEN 'uncertain'
              ELSE metadata->'hotelConfirmationRecovery'->>'alertDispatch' END)),
        side_effects_processed_at = NULL, updated_at = NOW()
      WHERE id = ${bookingId} AND status = 'confirmed'
        AND (side_effects_processed_at IS NULL OR metadata->'hotelConfirmationRecovery'->>'version' IS NULL)
        AND (COALESCE(metadata->'hotelConfirmationRecovery'->>'claimToken', '') = ''
          OR CASE WHEN metadata->'hotelConfirmationRecovery'->>'claimExpiresAtMs' ~ '^[0-9]{1,15}$'
            THEN (metadata->'hotelConfirmationRecovery'->>'claimExpiresAtMs')::bigint ELSE 0 END
              <= (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
      RETURNING *
    `);
    const booking = (claimed.rows as Array<Record<string, unknown>>)[0];
    if (!booking) return;
    const metadata = booking.metadata as Record<string, unknown>;
    const state = metadata.hotelConfirmationRecovery as Record<string, unknown>;
    const userId = Number(booking.user_id);
    let step = 'contact';
    try {
      let contactId = state.contactId ? Number(state.contactId) : null;
      if (!state.contactReady) {
        if (booking.lead_id) {
          const { crmService } = await import('../CRMService.js');
          const contact = await crmService.materializeContactReference(userId,
            -Math.abs(Number(booking.lead_id)), 'hotel_booking');
          if (!contact?.id) throw new Error('Booking CRM contact could not be materialized.');
          contactId = contact.id;
        }
        await this.updateConfirmationRecovery(bookingId, claimToken, { contactReady: true, contactId });
      }

      step = 'reminders';
      if (!state.remindersReady) {
        // Recheck ownership/status before the shared helper; its idempotent
        // persistence contract makes a crash before the next marker retryable.
        await this.updateConfirmationRecovery(bookingId, claimToken, {});
        const propertyRows = await db.execute(sql`
          SELECT timezone, check_in_time, check_out_time FROM hotel_properties
          WHERE id = ${Number(booking.hotel_property_id)} AND user_id = ${userId} LIMIT 1
        `);
        const property = propertyRows.rows[0] as Record<string, unknown> | undefined;
        const { reminderService } = await import('../ReminderService.js');
        await reminderService.scheduleBookingReminders(userId, {
          id: bookingId, checkIn: dateOnly(booking.check_in_date), checkOut: dateOnly(booking.check_out_date),
          guestName: typeof booking.guest_name === 'string' ? booking.guest_name : null,
          timezone: String(property?.timezone || DEFAULT_BUSINESS_TIMEZONE),
          checkInTime: property?.check_in_time ? String(property.check_in_time).slice(0, 8) : undefined,
          checkOutTime: property?.check_out_time ? String(property.check_out_time).slice(0, 8) : undefined,
        }, contactId);
        await this.updateConfirmationRecovery(bookingId, claimToken, { remindersReady: true });
      }

      step = 'alert';
      if (!state.alertDispatch) {
        // Persist BEFORE invoking a helper that can send externally. A crash or
        // exception after this point has an uncertain outcome, never a blind retry.
        await this.updateConfirmationRecovery(bookingId, claimToken, { alertDispatch: 'started' });
        try {
          const { alertService } = await import('../AlertService.js');
          await alertService.fireEvent(userId, 'deal_won', { contactId: contactId || undefined,
            metadata: { bookingId, totalPrice: Number(booking.total_price), currency: String(booking.currency) } });
        } catch (error) {
          await this.updateConfirmationRecovery(bookingId, claimToken, { alertDispatch: 'uncertain' });
          throw error;
        }
        await this.updateConfirmationRecovery(bookingId, claimToken, { alertDispatch: 'returned' });
      } else if (state.alertDispatch !== 'returned') {
        await this.updateConfirmationRecovery(bookingId, claimToken, { alertDispatch: 'uncertain', lastFailedStep: 'alert_reconciliation' });
        return;
      }

      step = 'completion';
      await this.updateConfirmationRecovery(bookingId, claimToken, { lastFailedStep: null });
      await db.execute(sql`UPDATE bookings SET side_effects_processed_at = NOW(), updated_at = NOW()
        WHERE id = ${bookingId} AND status = 'confirmed'
          AND metadata->'hotelConfirmationRecovery'->>'claimToken' = ${claimToken}`);
    } catch (error) {
      await this.updateConfirmationRecovery(bookingId, claimToken, { lastFailedStep: step })
        .catch(() => undefined);
      const current = await db.execute(sql`SELECT status FROM bookings WHERE id = ${bookingId} LIMIT 1`);
      if ((current.rows[0] as { status?: string } | undefined)?.status !== 'confirmed') {
        // Cancellation may commit while an awaited helper inserts its reminders.
        await this.cancelConfirmationReminders(bookingId, userId);
      }
      logger.error({ err: error, bookingId, step }, '[BookingService] Confirmation recovery step is unfinished');
    } finally {
      await db.execute(sql`UPDATE bookings SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
        '{hotelConfirmationRecovery}', COALESCE(metadata->'hotelConfirmationRecovery', '{}'::jsonb)
          || '{"claimToken":null,"claimExpiresAtMs":0}'::jsonb), updated_at = NOW()
        WHERE id = ${bookingId} AND metadata->'hotelConfirmationRecovery'->>'claimToken' = ${claimToken}`);
    }
  }

  private safeHttpsUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password
        ? parsed.toString()
        : null;
    } catch {
      return null;
    }
  }

  private toRecord(booking: Record<string, unknown>): BookingRecord {
    return {
      id: Number(booking.id),
      status: String(booking.status),
      paymentStatus: String(booking.payment_status),
      totalPrice: Number(booking.total_price),
      currency: String(booking.currency),
      checkIn: dateOnly(booking.check_in_date),
      checkOut: dateOnly(booking.check_out_date),
      nights: Number(booking.nights),
      rooms: Number(booking.number_of_rooms),
      roomTypeId: Number(booking.room_type_id),
      hotelPropertyId: Number(booking.hotel_property_id),
      paymentLink: typeof booking.payment_link === 'string' ? booking.payment_link : null,
      paymentProvider: typeof booking.payment_provider === 'string' ? booking.payment_provider : null,
      holdExpiresAt: optionalIso(booking.hold_expires_at),
      cancellationReason: typeof booking.cancellation_reason === 'string'
        ? booking.cancellation_reason
        : null,
      inventoryReserved: Boolean(booking.inventory_reserved_at) && !booking.inventory_released_at,
    };
  }
}

export const bookingService = new BookingService();
