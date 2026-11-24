import { SubAgentBase, SubAgentContext, SubAgentResult } from './SubAgentBase.js';
import { db } from '../../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../../utils/logger.js';
import {
  getHotelPaymentConfiguration,
  isMockPaymentAllowed,
} from '../../booking/PaymentProvider.js';

function safeGuestPaymentUrl(value: unknown, provider?: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') return parsed.toString();
    const isLoopback = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1';
    return provider === 'mock' && isMockPaymentAllowed() && parsed.protocol === 'http:' && isLoopback
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export class PaymentSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'payment',
    name: 'Payment Sub-Agent',
    description: 'Manages hotel payment method configurations, sharing payment links, and checking payment statuses.',
    intents: ['payment_inquiry'],
    priority: 30,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_payment_methods',
          description: 'Retrieve the active payment methods configured for the hotel (Razorpay, UPI QR, Bank Transfer, Manual Cash, etc.).',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_payment_link',
          description: 'Retrieve or generate a payment link for a pending booking and send it to the guest.',
          parameters: {
            type: 'object',
            properties: {
              booking_id: { type: 'integer', description: 'ID of the booking to get the payment link for.' },
            },
            required: ['booking_id'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'check_payment_status',
          description: 'Check if payment has been received for a specific booking.',
          parameters: {
            type: 'object',
            properties: {
              booking_id: { type: 'integer', description: 'ID of the booking to verify.' },
            },
            required: ['booking_id'],
          },
        },
      },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult> {
    const { userId } = ctx;
    const conversationId = Number.isSafeInteger(ctx.conversationId) && (ctx.conversationId > 0
      || (ctx.widgetSession && Number.isSafeInteger(ctx.widgetSession.id) && ctx.widgetSession.id > 0
        && ctx.conversationId === -ctx.widgetSession.id))
      ? ctx.conversationId : null;
    const leadId = Number.isSafeInteger(ctx.lead?.id) && Number(ctx.lead.id) > 0 ? Number(ctx.lead.id) : null;

    switch (name) {
      case 'get_payment_methods': {
        try {
          const paymentConfig = await getHotelPaymentConfiguration(userId);
          if (!paymentConfig.paymentMethodsEnabled) {
            return {
              toolResults: [{
                name,
                result: {
                  confirmedSideEffect: false,
                  success: true,
                  mode: 'external_booking',
                  payment_methods: [],
                  configured: Boolean(paymentConfig.externalBooking.url),
                  message: 'Payment methods are unavailable in this booking mode. Please use the hotel booking page for checkout.',
                },
              }],
            };
          }
          const provider = paymentConfig.provider;
          const methods = paymentConfig.methods;
          const enabledMethods: string[] = [];

          const onlineEnabled = methods.online?.enabled === true;

          if (onlineEnabled) {
            if (
              provider === 'razorpay'
              && paymentConfig.keyId
              && paymentConfig.keySecret
              && paymentConfig.webhookSecret
            ) {
              enabledMethods.push('Online Card/UPI (Razorpay Gateway): Guests can pay online securely.');
            } else if (provider === 'mock' && isMockPaymentAllowed()) {
              enabledMethods.push('Online Card/UPI (Mock Gateway): Demo online payments enabled.');
            }
          }

          if (methods.upiQr?.enabled && methods.upiQr.upiId) {
            let upiStr = `UPI Scan & Pay (QR Code): UPI ID is ${methods.upiQr.upiId}`;
            if (methods.upiQr.payeeName) upiStr += `, Payee Name: ${methods.upiQr.payeeName}`;
            if (methods.upiQr.qrImageUrl) upiStr += `. QR Image URL: ${methods.upiQr.qrImageUrl}`;
            enabledMethods.push(upiStr);
          }

          if (methods.bankTransfer?.enabled && methods.bankTransfer.accountNumber && methods.bankTransfer.ifscCode) {
            enabledMethods.push(`Direct Bank Transfer: Bank: ${methods.bankTransfer.bankName || 'N/A'}, Account Holder: ${methods.bankTransfer.payeeName || 'N/A'}, Account Number: ${methods.bankTransfer.accountNumber}, IFSC Code: ${methods.bankTransfer.ifscCode}`);
          }

          const customPaymentUrl = methods.customLink?.enabled
            ? safeGuestPaymentUrl(methods.customLink.url, 'custom')
            : null;
          if (customPaymentUrl) {
            enabledMethods.push(`Custom Payment Link: URL: ${customPaymentUrl}${methods.customLink?.linkTitle ? ` (${methods.customLink.linkTitle})` : ''}`);
          }

          if (methods.manual?.enabled && methods.manual.instructions) {
            enabledMethods.push(`Manual/Cash: ${methods.manual.instructions}`);
          }

          return {
            toolResults: [{
              name,
              result: {
                confirmedSideEffect: false,
                success: true,
                payment_methods: enabledMethods,
                configured: enabledMethods.length > 0,
                integration_required: enabledMethods.length === 0,
                ...(enabledMethods.length === 0 ? { message: 'No payment methods are configured.' } : {}),
              }
            }]
          };
        } catch (err) {
          logger.error({ err }, '[PaymentSubAgent] Failed to load payment settings');
          return {
            toolResults: [{
              name,
              result: { error: 'Failed to retrieve payment methods config.' }
            }]
          };
        }
      }

      case 'send_payment_link': {
        if (conversationId === null && leadId === null) return { toolResults: [{ name,
          result: { success: false, error: 'No verified customer booking context is available.' } }] };
        try {
          const rows = await db.execute(sql`
            SELECT id, status, payment_link, payment_provider, total_price, currency 
            FROM bookings 
            WHERE id = ${args.booking_id} AND user_id = ${userId}
              AND ((${conversationId}::integer IS NOT NULL AND outreach_conversation_id = ${conversationId})
                OR (${leadId}::integer IS NOT NULL AND lead_id = ${leadId}))
            LIMIT 1
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const booking = (rows.rows as any[])[0];

          if (!booking) {
            return {
              toolResults: [{
                name,
                result: { error: `Booking #${args.booking_id} not found.` }
              }]
            };
          }

          if (booking.status === 'confirmed') {
            return {
              toolResults: [{
                name,
                result: { success: true, confirmedSideEffect: false, message: 'This booking is already paid and confirmed.' }
              }]
            };
          }

          const link = safeGuestPaymentUrl(booking.payment_link, booking.payment_provider);
          if (!link) {
            return {
              toolResults: [{
                name,
                result: { error: 'No safe payment link has been generated for this booking.' }
              }]
            };
          }

          return {
            toolResults: [{
              name,
              result: {
                success: true,
                confirmedSideEffect: false,
                booking_id: booking.id,
                total_price: booking.total_price,
                currency: booking.currency,
                payment_link: link,
                note: 'Share this payment link with the guest to finalize checkout.'
              }
            }]
          };
        } catch (err) {
          logger.error({ err }, '[PaymentSubAgent] Failed to send payment link');
          return {
            toolResults: [{
              name,
              result: { error: 'Failed to retrieve booking payment link.' }
            }]
          };
        }
      }

      case 'check_payment_status': {
        if (conversationId === null && leadId === null) return { toolResults: [{ name,
          result: { success: false, error: 'No verified customer booking context is available.' } }] };
        try {
          const rows = await db.execute(sql`
            SELECT id, status, payment_status, total_price, currency 
            FROM bookings 
            WHERE id = ${args.booking_id} AND user_id = ${userId}
              AND ((${conversationId}::integer IS NOT NULL AND outreach_conversation_id = ${conversationId})
                OR (${leadId}::integer IS NOT NULL AND lead_id = ${leadId}))
            LIMIT 1
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const booking = (rows.rows as any[])[0];

          if (!booking) {
            return {
              toolResults: [{
                name,
                result: { error: `Booking #${args.booking_id} not found.` }
              }]
            };
          }

          const paid = booking.status === 'confirmed' || booking.payment_status === 'paid';
          return {
            toolResults: [{
              name,
              result: {
                success: true,
                confirmedSideEffect: false,
                booking_id: booking.id,
                status: booking.status,
                payment_status: booking.payment_status,
                paid,
                total_price: booking.total_price,
                currency: booking.currency,
              }
            }],
            crmPipelineStatus: paid ? 'won' : undefined
          };
        } catch (err) {
          logger.error({ err }, '[PaymentSubAgent] Failed to check payment status');
          return {
            toolResults: [{
              name,
              result: { error: 'Failed to verify payment status.' }
            }]
          };
        }
      }

      default:
        throw new Error(`Tool ${name} not implemented by PaymentSubAgent`);
    }
  }
}
export const paymentSubAgent = new PaymentSubAgent();
