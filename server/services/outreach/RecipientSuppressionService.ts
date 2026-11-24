import { normalizeMSG91Phone } from '../../../shared/msg91.js';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

export function normalizeOutreachDestination(
  channel: string,
  value: string,
): string {
  if (channel === 'sms') return normalizeMSG91Phone(value) || '';
  if (['email', 'gmail', 'resend'].includes(channel)) return value.trim().toLowerCase();
  const digits = value.replace(/\D/g, '');
  // "0091…" and "+91…" are the same WhatsApp number; outreach sends to the form without "00".
  return channel === 'whatsapp' ? digits.replace(/^00/, '') : digits;
}

/** Address-wide within the active business scope. Never infer an old recipient
 * from a lead's current address: contacts may have changed since delivery. */
export async function getSuppressedRecipients(
  userId: number,
  channel: string,
  addresses: string[],
  executor: Pick<typeof db, 'execute'> = db,
): Promise<Set<string>> {
  if (
    !['email', 'gmail', 'resend', 'sms', 'whatsapp'].includes(channel) ||
    !addresses.length
  )
    return new Set();
  const email = ['email', 'gmail', 'resend'].includes(channel);
  const phone = sql`regexp_replace(COALESCE(l.phone,''),'[^0-9]','','g')`;
  const normalizedPhone =
    channel === 'sms'
      ? sql`CASE WHEN trim(l.phone) !~ '^(\\+|00)' AND length(${phone})=10 THEN '91'||${phone}
    WHEN trim(l.phone) ~ '^00' THEN substring(${phone} from 3) ELSE ${phone} END`
      : phone;
  const destinations = [
    ...new Set(
      addresses
        .map((value) => normalizeOutreachDestination(channel, value))
        .filter(Boolean),
    ),
  ];
  if (!destinations.length) return new Set();
  const result = await executor.execute(sql`
    WITH suppressed_leads AS MATERIALIZED (
      SELECT ${channel === 'whatsapp' ? sql`alias.destination` : email ? sql`lower(trim(l.email))` : normalizedPhone} AS destination
      FROM leads l ${channel === 'whatsapp' ? sql`CROSS JOIN LATERAL (
        VALUES (regexp_replace(${phone},'^00','')),
               (regexp_replace(regexp_replace(COALESCE(l.whatsapp,''),'[^0-9]','','g'),'^00',''))
      ) AS alias(destination)` : sql``} WHERE l.user_id=${userId}
        AND (COALESCE(l.blacklisted,false) OR COALESCE(l.do_not_contact,false) ${email ? sql`OR COALESCE(l.email_unsubscribed,false)` : sql``})
    )
    SELECT destination FROM unnest(ARRAY[${sql.join(
      destinations.map((destination) => sql`${destination}`),
      sql`, `,
    )}]::text[]) AS address(destination)
    WHERE EXISTS (
      SELECT 1 FROM suppressed_leads blocked WHERE blocked.destination=address.destination
    ) ${
      email
        ? sql`OR EXISTS (
      SELECT 1 FROM sent_messages receipt WHERE receipt.user_id=${userId}
        AND receipt.channel IN ('email','gmail','resend')
        AND lower(trim(COALESCE(NULLIF(receipt.recipient_address,''),
          CASE WHEN receipt.lead_name ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN receipt.lead_name END)))=destination
        AND (receipt.bounced_at IS NOT NULL OR receipt.status IN ('bounced','complained') OR receipt.delivery_status IN ('bounced','complained'))
    )`
        : sql``
    }
  `);
  return new Set(
    (result.rows as Array<{ destination: string }>).map(
      (row) => row.destination,
    ),
  );
}

export class RecipientSuppressedError extends Error {}

export async function assertRecipientNotSuppressed(
  userId: number,
  channel: string,
  recipient: string,
  executor: Pick<typeof db, 'execute'> = db,
): Promise<void> {
  if (
    (await getSuppressedRecipients(userId, channel, [recipient], executor)).has(
      normalizeOutreachDestination(channel, recipient),
    )
  ) {
    throw new RecipientSuppressedError(
      'This recipient is opted out, blacklisted, or suppressed after a delivery failure.',
    );
  }
}
