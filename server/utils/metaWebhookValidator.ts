import { z } from 'zod';
import crypto from 'crypto';

/**
 * Zod schema to robustly validate Meta's deeply nested Webhook payload.
 * Ensures we never crash on `undefined` when reading entries and messages.
 */
export const WhatsAppMessagePayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.preprocess(value => Array.isArray(value) ? value.filter(change => ['messages','smb_message_echoes'].includes(change?.field)) : value, z.array(
        z.object({
          field: z.enum(['messages', 'smb_message_echoes']),
          value: z.object({
            messaging_product: z.literal('whatsapp').optional(),
            metadata: z.object({
              display_phone_number: z.string().optional(),
              phone_number_id: z.string(),
            }),
            message_echoes: z.array(z.object({
              from: z.string(), to: z.string(), id: z.string(), timestamp: z.coerce.string(), type: z.string(),
              text: z.object({ body: z.string() }).optional(), image: z.any().optional(), video: z.any().optional(),
              document: z.any().optional(), audio: z.any().optional(), edit: z.any().optional(), revoke: z.any().optional(),
            })).optional(),
            contacts: z.array(z.any()).optional(),
            messages: z.array(
              z.object({
                from: z.string(),
                id: z.string(),
                timestamp: z.string(),
                type: z.string(),
                text: z.object({ body: z.string() }).optional(),
                image: z.any().optional(),
                video: z.any().optional(),
                audio: z.any().optional(),
                document: z.any().optional(),
                location: z.any().optional(),
                contacts: z.any().optional(),
                interactive: z.any().optional(),
                button: z.any().optional(),
                context: z.any().optional(),
              })
            ).optional(),
            statuses: z.array(
              z.object({
                id: z.string(),
                status: z.string(), // sent | delivered | read | failed
                timestamp: z.string(),
                recipient_id: z.string().optional(),
                conversation: z.any().optional(),
                pricing: z.any().optional(),
                errors: z.array(z.any()).optional(),
              })
            ).optional(),
          })
        })
      ))
    })
  )
});

/**
 * Validates the X-Hub-Signature-256 header against the request raw body using Meta App Secret
 */
export function verifyMetaSignature(signature: string | undefined, rawBody: Buffer, appSecret: string): boolean {
  if (!signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const signatureHash = signature.split('=')[1];
  const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // Time-safe comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHash), Buffer.from(expectedHash));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    return false; // Length mismatch etc
  }
}
