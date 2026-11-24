import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { logger } from '../utils/logger.js';
import {
  BookingLifecycleError,
  bookingService,
} from '../services/booking/BookingService.js';
import { getPaymentProviderForUser, isMockPaymentAllowed } from '../services/booking/PaymentProvider.js';
import type { BookingRecord } from '../services/booking/types.js';
import { escapeHtml } from '../utils/personalization.js';
import { recordPaymentEvidence } from '../services/insights/SalesEvidence.js';

interface ConfirmationContext {
  user_id: number;
  total_price: string | number;
  currency: string;
  check_in_date: string | Date;
  check_out_date: string | Date;
  number_of_rooms: number;
  conversation_id?: number | null;
  channel?: string | null;
  phone?: string | null;
  lead_email?: string | null;
  lead_instagram?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Brand saved on the booking's conversation (migration 589). */
  brand_toolkit_id?: number | null;
  phone_number_id?: string | null;
  hotel_name?: string | null;
  locale?: string | null;
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function formatMoney(value: string | number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

async function sendConfirmation(bookingId: number): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT
      b.user_id,
      b.total_price,
      b.currency,
      b.check_in_date,
      b.check_out_date,
      b.number_of_rooms,
      hp.name AS hotel_name,
      up.locale,
      oc.id AS conversation_id,
      oc.channel,
      oc.external_thread_id AS phone,
      oc.lead_email,
      oc.lead_instagram,
      oc.metadata,
      oc.brand_toolkit_id,
      (
        SELECT phone_number_id
        FROM outreach_messages
        WHERE conversation_id = b.outreach_conversation_id
          AND phone_number_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) AS phone_number_id
    FROM bookings b
    JOIN hotel_properties hp
      ON hp.id = b.hotel_property_id
     AND hp.user_id = b.user_id
    LEFT JOIN user_preferences up ON up.user_id = b.user_id
    LEFT JOIN outreach_conversations oc ON oc.id = b.outreach_conversation_id
    WHERE b.id = ${bookingId}
      AND b.status = 'confirmed'
    LIMIT 1
  `);
  const context = (rows.rows as ConfirmationContext[])[0];
  if (!context) {
    logger.warn({ bookingId }, '[payment] Confirmation context was not found');
    return false;
  }

  const checkIn = dateOnly(context.check_in_date);
  const checkOut = dateOnly(context.check_out_date);
  const locale = context.locale || 'en-IN';
  const hotelName = context.hotel_name || 'Your hotel';
  const total = formatMoney(context.total_price, context.currency, locale);
  const text = `${hotelName}: Booking #${bookingId} is confirmed for ${context.number_of_rooms} room(s), ${checkIn} to ${checkOut}. Total paid: ${total}. We look forward to hosting you.`;
  const channel = context.channel || '';

  try {
    if (channel === 'whatsapp' && context.phone && context.phone_number_id) {
      const { whatsappApiService } = await import('../services/whatsappApiService.js');
      await whatsappApiService.sendText({
        userId: Number(context.user_id),
        phoneNumberId: String(context.phone_number_id),
        to: String(context.phone).replace(/^\+/, ''),
        text,
      });
    } else if (channel === 'instagram' && (context.lead_instagram || context.phone)) {
      const { sendInstagramDM } = await import('../services/instagramService.js');
      await sendInstagramDM({
        recipientId: String(context.lead_instagram || context.phone),
        message: text,
        userId: Number(context.user_id),
        conversationId: Number(context.conversation_id),
      });
    } else if (
      channel === 'facebook'
      && (context.phone || context.metadata?.facebookPsid)
    ) {
      const { sendFacebookDM } = await import('../services/FacebookMessengerService.js');
      await sendFacebookDM({
        conversationId: Number(context.conversation_id),
        recipientId: String(context.phone || context.metadata?.facebookPsid),
        message: text,
        userId: Number(context.user_id),
      });
    } else if (channel === 'sms' && context.phone) {
      const { sendSMS } = await import('../services/smsService.js');
      await sendSMS(Number(context.user_id), context.phone, text);
    } else if (['email', 'gmail'].includes(channel) && context.lead_email) {
      const { emailService } = await import('../services/emailService.js');
      const { getBrandInfo, renderBrandedEmail } = await import('../utils/emailTemplates.js');
      const brand = await getBrandInfo(Number(context.user_id), context.brand_toolkit_id);
      await emailService.sendEmailWithUserCredentials(Number(context.user_id), {
        to: context.lead_email,
        subject: `${hotelName} booking confirmed · #${bookingId}`,
        text,
        html: renderBrandedEmail({
          brand,
          body: `<p>${escapeHtml(text)}</p>`,
        }),
        skipConversationLog: true,
      });
    } else if (channel === 'twitter' && (context.phone || context.metadata?.twitterId)) {
      const { sendTwitterDM } = await import('../services/TwitterApiService.js');
      await sendTwitterDM({
        recipientId: String(context.phone || context.metadata?.twitterId),
        message: text,
        userId: Number(context.user_id),
      });
    } else if (channel === 'linkedin' && (context.phone || context.metadata?.linkedinUrn)) {
      const { sendLinkedInDM } = await import('../services/LinkedInApiService.js');
      await sendLinkedInDM({
        recipientUrn: String(context.phone || context.metadata?.linkedinUrn),
        message: text,
        userId: Number(context.user_id),
      });
    } else {
      logger.info(
        { bookingId, channel },
        '[payment] Booking confirmed without a configured customer notification channel',
      );
      return false;
    }

    if (context.conversation_id) {
      const { createOutreachMessage } = await import('../models/outreachConversations/functions.js');
      await createOutreachMessage({
        conversationId: Number(context.conversation_id),
        userId: Number(context.user_id),
        direction: 'outbound',
        content: text,
        status: 'sent',
        isAutomatic: true,
        isAiGenerated: false,
        isRead: true,
      });
    }
    return true;
  } catch (error) {
    logger.error({ err: error, bookingId, channel }, '[payment] Booking confirmation send failed');
    return false;
  }
}

async function sendConfirmationOnce(bookingId: number): Promise<void> {
  if (!(await bookingService.claimConfirmationNotification(bookingId))) return;
  const sent = await sendConfirmation(bookingId);
  await bookingService.completeConfirmationNotification(bookingId, sent);
}

function lifecycleErrorResponse(res: Response, error: unknown): void {
  if (error instanceof BookingLifecycleError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: 'Unable to update the booking. Please retry or review it from the hotel dashboard.',
  });
}

/** Signed Razorpay webhook. Raw request bytes are required for HMAC verification. */
export async function handlePaymentWebhook(req: Request, res: Response): Promise<void> {
  try {
    const payload = req.body || {};
    const untrustedPaymentRef = payload?.payload?.payment_link?.entity?.id
      || payload?.payload?.payment?.entity?.order_id
      || payload?.payload?.order?.entity?.id;
    const untrustedBookingId = payload?.payload?.payment?.entity?.notes?.bookingId
      || payload?.payload?.payment_link?.entity?.notes?.bookingId
      || payload?.payload?.order?.entity?.notes?.bookingId;
    const untrustedRefundPaymentId = payload?.payload?.refund?.entity?.payment_id;

    const ownerRows = await withSystemScope('Resolve signed booking payment owner', async () => untrustedPaymentRef
      ? await db.execute(sql`
          SELECT user_id,business_profile_id
          FROM bookings
          WHERE payment_ref = ${String(untrustedPaymentRef)}
          LIMIT 1
        `)
      : untrustedRefundPaymentId
        ? await db.execute(sql`SELECT user_id,business_profile_id FROM bookings WHERE payment_id=${String(untrustedRefundPaymentId)} LIMIT 1`)
      : untrustedBookingId
        ? await db.execute(sql`
            SELECT user_id,business_profile_id
            FROM bookings
            WHERE id = ${Number(untrustedBookingId)}
            LIMIT 1
          `)
        : { rows: [] });
    const userId = Number((ownerRows.rows as Array<{ user_id?: number }>)[0]?.user_id || 0);
    if (!userId) {
      res.status(404).json({ success: false, error: 'Booking not found' });
      return;
    }

    const businessProfileId = Number(ownerRows.rows[0]?.business_profile_id);
    if (!businessProfileId) { res.status(404).json({ error:'Booking business unavailable' }); return; }
    return await withBusinessScope({ userId,businessProfileId }, async () => {
    const provider = await getPaymentProviderForUser(userId);
    if (!provider || provider.name !== 'razorpay') {
      res.status(400).json({ success: false, error: 'Razorpay is not configured for this booking' });
      return;
    }
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const verified = await provider.verifyWebhook(req.body, req.headers, rawBody);
    if (!verified.ok || (verified.kind !== 'refund' && !verified.paymentRef)) {
      logger.warn(
        { userId, reason: verified.reason },
        '[payment] Rejected unverified or non-successful Razorpay webhook',
      );
      res.status(400).json({ success: false, error: 'Invalid or unverified payment webhook' });
      return;
    }

    if (verified.kind === 'refund') {
      const refundBooking = await db.execute(sql`SELECT id FROM bookings WHERE payment_id=${verified.paymentId||''}
        AND business_profile_id=${businessProfileId} AND user_id=${userId} LIMIT 1`);
      const id=Number(refundBooking.rows[0]?.id);
      if (!id || !verified.refundId || !verified.amountMinor || !verified.currency) {
        res.status(400).json({success:false,error:'Refund payment evidence is incomplete'}); return;
      }
      await recordPaymentEvidence({bookingId:id,paymentId:verified.paymentId!,refundId:verified.refundId,
        amountMinor:verified.amountMinor,currency:verified.currency.toUpperCase(),occurredAt:verified.occurredAt||new Date().toISOString(),source:'razorpay'});
      await bookingService.reconcileRefundStatus(id, userId);
      res.json({success:true,bookingId:id,status:'refund_recorded'}); return;
    }
    if (!verified.paymentId || !verified.amountMinor || !verified.currency) {
      res.status(400).json({ success:false,error:'Captured payment evidence is incomplete' }); return;
    }
    const booking = await bookingService.confirmBooking(verified.paymentRef!, verified.paymentId, {
      amountMinor: verified.amountMinor, currency: verified.currency,
      source: 'razorpay', occurredAt: verified.occurredAt || new Date().toISOString(),
    });
    if (!booking) {
      res.status(404).json({ success: false, error: 'Booking not found' });
      return;
    }
    await sendConfirmationOnce(booking.id);
    res.json({ success: true, bookingId: booking.id, status: booking.status });
    });
  } catch (error) {
    logger.error({ err: error }, '[payment] Webhook handler failed');
    lifecycleErrorResponse(res, error);
  }
}

/** Local-only bearer payment link. The opaque reference is looked up exactly. */
export async function handleMockPaymentConfirm(req: Request, res: Response): Promise<void> {
  try {
    if (!isMockPaymentAllowed()) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    const ref = String(req.query.ref || req.body?.ref || '');
    if (!/^mock_[0-9a-f]{48}$/.test(ref)) {
      res.status(400).json({ success: false, error: 'Invalid payment reference' });
      return;
    }
    const ownerRows = await withSystemScope('Resolve mock payment capability', () => db.execute(sql`
      SELECT user_id,business_profile_id,payment_id
      FROM bookings
      WHERE payment_ref = ${ref}
        AND payment_provider = 'mock'
      LIMIT 1
    `));
    const userId = Number((ownerRows.rows as Array<{ user_id?: number }>)[0]?.user_id || 0);
    if (!userId) {
      res.status(404).json({ success: false, error: 'Booking not found' });
      return;
    }
    const businessProfileId = Number(ownerRows.rows[0]?.business_profile_id);
    if (!businessProfileId) { res.status(404).json({ error:'Booking business unavailable' }); return; }
    return await withBusinessScope({ userId,businessProfileId }, async () => {
    const provider = await getPaymentProviderForUser(userId);
    if (!provider || provider.name !== 'mock') {
      res.status(400).json({ success: false, error: 'Mock payments are not enabled' });
      return;
    }
    const verified = await provider.verifyWebhook({ ref }, req.headers);
    if (!verified.ok || !verified.paymentRef) {
      res.status(400).json({ success: false, error: 'Invalid payment reference' });
      return;
    }
    // The capability itself identifies one local simulation. Preserve a stored
    // payment id on replay, including receipts issued by older mock providers.
    const paymentId = ownerRows.rows[0]?.payment_id
      ? String(ownerRows.rows[0].payment_id) : verified.paymentId;
    const booking = await bookingService.confirmBooking(verified.paymentRef, paymentId);
    if (!booking) {
      res.status(404).json({ success: false, error: 'Booking not found' });
      return;
    }
    await sendConfirmationOnce(booking.id);

    const hotelRows = await db.execute(sql`
      SELECT name FROM hotel_properties WHERE id = ${booking.hotelPropertyId} LIMIT 1
    `);
    const hotelName = String((hotelRows.rows as Array<{ name?: string }>)[0]?.name || 'Your hotel');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.send(renderConfirmationHtml(booking, hotelName));
    });
  } catch (error) {
    logger.error({ err: error }, '[payment] Mock confirmation failed');
    lifecycleErrorResponse(res, error);
  }
}

/** Authenticated hotel-owner confirmation for manual/offline payments. */
export async function manuallyConfirmBooking(req: Request, res: Response): Promise<void> {
  try {
    const userId = businessOwnerUserId(req);
    const bookingId = Number(req.params.id);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      res.status(400).json({ success: false, error: 'A valid booking ID is required' });
      return;
    }
    const receipt=req.body?.receipt;
    let manualReceipt: { amountMinor: number; currency: string; reference: string; occurredAt: string } | undefined;
    if (receipt !== undefined) {
      const amount=Number(receipt?.amount), reference=String(receipt?.reference||'').trim();
      const currency=String(receipt?.currency||'').toUpperCase();
      const occurredAt=typeof receipt?.occurredAt==='string'?receipt.occurredAt:new Date().toISOString();
      if (!Number.isFinite(amount)||amount<=0||!Number.isSafeInteger(Math.round(amount*100))
        ||Math.abs(amount*100-Math.round(amount*100))>1e-7||!/^[A-Z]{3}$/.test(currency)
        || !/^[\w./-]{3,180}$/.test(reference)||!Number.isFinite(Date.parse(occurredAt))) {
        res.status(400).json({success:false,error:'A receipt requires a valid amount, currency, reference, and occurrence time.'}); return;
      }
      manualReceipt={amountMinor:Math.round(amount*100),currency,reference,occurredAt};
    }
    const booking = await bookingService.confirmBookingById(
      bookingId,
      userId,
      'manual_dashboard',
      manualReceipt ? {
        amountMinor: manualReceipt.amountMinor, currency: manualReceipt.currency,
        paymentId: `manual:${manualReceipt.reference}`,
        source: 'manual', occurredAt: manualReceipt.occurredAt,
      } : undefined,
    );
    if (!booking) {
      res.status(404).json({ success: false, error: 'Booking not found' });
      return;
    }
    await sendConfirmationOnce(booking.id);
    let confirmationRecovery;
    try { confirmationRecovery = await bookingService.getConfirmationRecovery(booking.id, userId); }
    catch (error) {
      logger.warn({ err: error, bookingId: booking.id }, '[payment] Confirmed booking setup status is unavailable');
      confirmationRecovery = { state: 'needs_review', canRetry: false, step: 'unknown' };
    }
    res.json({ success: true, bookingId: booking.id, status: booking.status,
      confirmationRecovery });
  } catch (error) {
    logger.error({ err: error }, '[payment] Manual booking confirmation failed');
    lifecycleErrorResponse(res, error);
  }
}

/** Explicit setup replay, without capture/refund or guest-confirmation dispatch. */
export async function retryBookingConfirmationSetup(req: Request, res: Response): Promise<void> {
  try {
    const userId = businessOwnerUserId(req), bookingId = Number(req.params.id);
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) { res.status(400).json({ error: 'A valid booking ID is required.' }); return; }
    const confirmationRecovery = await bookingService.retryConfirmationRecovery(bookingId, userId);
    if (!confirmationRecovery) { res.status(404).json({ error: 'Booking not found' }); return; }
    res.json({ success: true, bookingId, confirmationRecovery });
  } catch (error) { lifecycleErrorResponse(res, error); }
}

/** Authenticated owner cancellation. Reserved inventory is restored exactly once. */
export async function cancelBooking(req: Request, res: Response): Promise<void> {
  try {
    const userId = businessOwnerUserId(req);
    const bookingId = Number(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      res.status(400).json({ success: false, error: 'A valid booking ID is required' });
      return;
    }
    if (!reason || reason.length > 1000) {
      res.status(400).json({ success: false, error: 'A cancellation reason is required' });
      return;
    }
    const booking = await bookingService.cancelBookingById(bookingId, userId, reason);
    if (!booking) {
      res.status(404).json({ success: false, error: 'Booking not found' });
      return;
    }
    res.json({
      success: true,
      bookingId: booking.id,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
    });
  } catch (error) {
    logger.error({ err: error }, '[payment] Booking cancellation failed');
    lifecycleErrorResponse(res, error);
  }
}

function renderConfirmationHtml(booking: BookingRecord, hotelName: string): string {
  const safeHotel = escapeHtml(hotelName);
  const total = escapeHtml(formatMoney(booking.totalPrice, booking.currency, 'en-IN'));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Booking confirmed</title>
  <style>
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0f172a;color:#f8fafc;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    main{width:min(100%,520px);padding:32px;border:1px solid #334155;border-radius:20px;background:#1e293b;box-shadow:0 24px 80px rgba(0,0,0,.35)}
    .mark{display:grid;place-items:center;width:52px;height:52px;margin-bottom:20px;border-radius:999px;background:#16a34a;font-size:28px}
    h1{margin:0 0 8px;font-size:28px;line-height:1.2}
    p{margin:0;color:#cbd5e1;line-height:1.6}
    dl{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0 0;padding:20px;border-radius:14px;background:#0f172a}
    dt{font-size:12px;color:#94a3b8}
    dd{margin:4px 0 0;font-weight:650}
    @media(max-width:420px){main{padding:24px}dl{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">✓</div>
    <h1>Booking confirmed</h1>
    <p>${safeHotel} has received your payment and reserved your stay.</p>
    <dl>
      <div><dt>Booking</dt><dd>#${booking.id}</dd></div>
      <div><dt>Total paid</dt><dd>${total}</dd></div>
      <div><dt>Check-in</dt><dd>${escapeHtml(booking.checkIn)}</dd></div>
      <div><dt>Check-out</dt><dd>${escapeHtml(booking.checkOut)}</dd></div>
    </dl>
  </main>
</body>
</html>`;
}
