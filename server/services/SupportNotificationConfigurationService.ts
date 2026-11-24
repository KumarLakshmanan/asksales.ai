import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { encryptValue } from './SecretsManager.js';
import {
  SupportMemberNotificationService,
  supportNotificationDestinationHint,
  type SupportNotificationEvent,
} from './SupportMemberNotificationService.js';

type Transaction = typeof db;

export const MEMBER_NOTIFICATION_EVENTS: readonly SupportNotificationEvent[] = [
  'ticket_created_unassigned',
  'ticket_assigned',
  'ticket_reassigned',
  'human_handoff',
  'customer_replied',
  'ticket_reopened',
  'sla_at_risk',
  'sla_breached',
  'approval_required',
  'delivery_failed',
  'ticket_resolved',
];

export const DEFAULT_ASSIGNED_MEMBER_EVENTS: ReadonlySet<SupportNotificationEvent> = new Set([
  'ticket_assigned',
  'ticket_reassigned',
  'human_handoff',
  'customer_replied',
  'ticket_reopened',
  'sla_at_risk',
  'sla_breached',
]);

export interface OwnerVerifiedMemberNotificationInput {
  userId: number;
  teamId: number;
  memberId: number;
  ownerUserId: number;
  email: { enabled: boolean; destination: string };
  whatsapp: { enabled: boolean; destination: string };
  whatsappConsentAcknowledged: boolean;
  events?: Partial<Record<SupportNotificationEvent, boolean>>;
}

export interface MemberNotificationContactInput {
  userId: number;
  teamId: number;
  memberId: number;
  ownerUserId: number;
  channel: 'email' | 'whatsapp';
  destination: string | null;
  consentAcknowledged?: boolean;
}

const DEFAULT_SUBJECT = '{{event_title}} · {{ticket_number}}';
const DEFAULT_TEXT = `{{event_title}}

Ticket: {{ticket_number}}
Priority: {{priority}}
Source: {{source_channel}}
Issue: {{safe_summary}}
Required action: {{required_action}}
Response target: {{response_target}}

Open ticket: {{ticket_url}}`;

/**
 * Drizzle treats a bare JavaScript array interpolation as a SQL row tuple.
 * Build an explicit PostgreSQL text array for immutable template versions.
 */
export function supportNotificationAllowedVariablesSql() {
  const variables = SupportMemberNotificationService.allowedTemplateVariables();
  return sql`ARRAY[${sql.join(variables.map((variable) => sql`${variable}`), sql`, `)}]::text[]`;
}

export async function ensureManagedAssignmentEmailTemplate(tx: Transaction, userId: number): Promise<void> {
  const template = await tx.execute(sql`
    INSERT INTO support_notification_templates (
      user_id, team_id, event_type, channel, locale, audience, name,
      status, active_version, managed_key, created_at, updated_at
    ) VALUES (
      ${userId}, NULL, 'ticket_assigned', 'email', 'en-IN', 'member',
      'Default ticket assignment email', 'published', 1,
      'managed.support.ticket_assigned.email.v1', NOW(), NOW()
    )
    ON CONFLICT (business_profile_id, user_id, team_id, event_type, channel, locale, audience)
      DO UPDATE SET updated_at = support_notification_templates.updated_at
    RETURNING id
  `);
  const templateId = Number((template.rows[0] as { id?: number } | undefined)?.id || 0);
  if (!templateId) return;
  const checksum = crypto.createHash('sha256').update(`${DEFAULT_SUBJECT}\n${DEFAULT_TEXT}`).digest('hex');
  await tx.execute(sql`
    INSERT INTO support_notification_template_versions (
      user_id, template_id, version, subject_template, text_template,
      allowed_variables, checksum, published_at, created_at
    ) VALUES (
      ${userId}, ${templateId}, 1, ${DEFAULT_SUBJECT}, ${DEFAULT_TEXT},
      ${supportNotificationAllowedVariablesSql()}, ${checksum}, NOW(), NOW()
    ) ON CONFLICT (template_id, version) DO NOTHING
  `);
}

/**
 * Synchronize the assigned member's contact destination independently of the
 * workspace-wide channel switch. This keeps member contact management in the
 * member profile while the Notifications page controls delivery globally.
 */
export async function syncOwnerVerifiedMemberNotificationContact(
  tx: Transaction,
  input: MemberNotificationContactInput,
): Promise<number | null> {
  await tx.execute(sql`SELECT set_config('app.current_user_id', ${String(input.userId)}, true)`);
  const destination = input.channel === 'email'
    ? String(input.destination || '').trim().toLowerCase()
    : String(input.destination || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (input.channel === 'whatsapp' && !input.consentAcknowledged) {
    throw new Error('Confirm that this member is authorized to update operational WhatsApp alerts.');
  }
  const current = await tx.execute(sql`
    SELECT id, destination_hash, destination_hint FROM support_notification_destinations
    WHERE user_id=${input.userId} AND team_id=${input.teamId}
      AND member_id=${input.memberId} AND channel=${input.channel} LIMIT 1
  `);
  const previous = current.rows[0] as { id?: number; destination_hash?: string; destination_hint?: string } | undefined;

  if (!destination) {
    if (!previous?.id) return null;
    await tx.execute(sql`
      UPDATE support_member_notification_deliveries
      SET status='cancelled', updated_at=NOW(), error_code='DESTINATION_REMOVED',
        last_error='Notification destination was removed before delivery.'
      WHERE user_id=${input.userId} AND destination_id=${Number(previous.id)}
        AND status IN ('pending','retry')
    `);
    await tx.execute(sql`
      INSERT INTO support_notification_audit_logs (
        user_id, member_id, actor_type, action, entity_type, entity_id, metadata, expires_at
      ) VALUES (
        ${input.userId}, ${input.memberId}, 'owner', 'destination.removed',
        'support_notification_destination', ${Number(previous.id)},
        ${JSON.stringify({ channel: input.channel, destinationHint: previous.destination_hint || 'masked destination' })}::jsonb,
        NOW() + INTERVAL '365 days'
      )
    `);
    await tx.execute(sql`
      DELETE FROM support_notification_destinations
      WHERE id=${Number(previous.id)} AND user_id=${input.userId}
    `);
    return null;
  }

  const digest = SupportMemberNotificationService.destinationDigest(input.channel, destination, input.userId);
  const duplicate = await tx.execute(sql`
    SELECT id FROM support_notification_destinations
    WHERE user_id=${input.userId} AND channel=${input.channel} AND destination_hash=${digest}
      AND member_id IS DISTINCT FROM ${input.memberId} LIMIT 1
  `);
  if (duplicate.rows[0]) {
    throw new Error(`This ${input.channel} notification destination is already assigned to another support member.`);
  }
  const saved = await tx.execute(sql`
    INSERT INTO support_notification_destinations (
      user_id, team_id, member_id, channel, destination_ciphertext, destination_hash,
      destination_hint, verification_status, verification_source, verified_by_user_id,
      owner_consent_at, owner_consent_version, verified_at, fingerprint_version, updated_at
    ) VALUES (
      ${input.userId}, ${input.teamId}, ${input.memberId}, ${input.channel}, ${encryptValue(destination)}, ${digest},
      ${supportNotificationDestinationHint(input.channel, destination)}, 'owner_verified', 'owner_attestation',
      ${input.ownerUserId}, NOW(), 'support-notifications-v2', NOW(), 2, NOW()
    )
    ON CONFLICT (member_id, channel) WHERE member_id IS NOT NULL
    DO UPDATE SET destination_ciphertext=EXCLUDED.destination_ciphertext,
      destination_hash=EXCLUDED.destination_hash, destination_hint=EXCLUDED.destination_hint,
      verification_status='owner_verified', verification_source='owner_attestation',
      verified_by_user_id=EXCLUDED.verified_by_user_id, owner_consent_at=NOW(),
      owner_consent_version='support-notifications-v2', verified_at=NOW(), fingerprint_version=2,
      verification_code_hash=NULL, verification_expires_at=NULL, updated_at=NOW()
    RETURNING id
  `);
  const destinationId = Number((saved.rows[0] as { id?: number } | undefined)?.id || 0);
  if (!destinationId) throw new Error(`Unable to save the ${input.channel} notification destination.`);
  if (previous?.id && previous.destination_hash !== digest) {
    await tx.execute(sql`
      UPDATE support_member_notification_deliveries
      SET status='cancelled', updated_at=NOW(), error_code='DESTINATION_CHANGED',
        last_error='Notification destination changed before delivery.'
      WHERE user_id=${input.userId} AND destination_id=${Number(previous.id)}
        AND status IN ('pending','retry')
    `);
  }
  await tx.execute(sql`
    INSERT INTO support_notification_audit_logs (
      user_id, member_id, actor_type, action, entity_type, entity_id, metadata, expires_at
    ) VALUES (
      ${input.userId}, ${input.memberId}, 'owner', 'destination.owner_verified',
      'support_notification_destination', ${destinationId},
      ${JSON.stringify({
        channel: input.channel,
        destinationHint: supportNotificationDestinationHint(input.channel, destination),
        consentVersion: 'support-notifications-v2',
      })}::jsonb,
      NOW() + INTERVAL '365 days'
    )
  `);
  return destinationId;
}

export async function configureOwnerVerifiedMemberNotifications(
  tx: Transaction,
  input: OwnerVerifiedMemberNotificationInput,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_user_id', ${String(input.userId)}, true)`);
  await ensureManagedAssignmentEmailTemplate(tx, input.userId);

  for (const channel of ['email', 'whatsapp'] as const) {
    const config = input[channel];
    if (!config.destination || !config.enabled) continue;
    if (channel === 'whatsapp' && config.enabled && !input.whatsappConsentAcknowledged) {
      throw new Error('Confirm that this member agreed to receive operational WhatsApp alerts.');
    }
    const digest = SupportMemberNotificationService.destinationDigest(channel, config.destination, input.userId);
    const duplicate = await tx.execute(sql`
      SELECT id FROM support_notification_destinations
      WHERE user_id=${input.userId} AND channel=${channel} AND destination_hash=${digest}
        AND member_id IS DISTINCT FROM ${input.memberId} LIMIT 1
    `);
    if (duplicate.rows[0]) throw new Error(`This ${channel} notification destination is already assigned to another support member.`);
    const current = await tx.execute(sql`
      SELECT id, destination_hash FROM support_notification_destinations
      WHERE user_id=${input.userId} AND team_id=${input.teamId}
        AND member_id=${input.memberId} AND channel=${channel} LIMIT 1
    `);
    const previous = current.rows[0] as { id?: number; destination_hash?: string } | undefined;
    const destination = await tx.execute(sql`
      INSERT INTO support_notification_destinations (
        user_id, team_id, member_id, channel, destination_ciphertext, destination_hash,
        destination_hint, verification_status, verification_source, verified_by_user_id,
        owner_consent_at, owner_consent_version, verified_at, fingerprint_version, updated_at
      ) VALUES (
        ${input.userId}, ${input.teamId}, ${input.memberId}, ${channel}, ${encryptValue(config.destination)}, ${digest},
        ${supportNotificationDestinationHint(channel, config.destination)}, 'owner_verified', 'owner_attestation',
        ${input.ownerUserId}, NOW(), 'support-notifications-v1', NOW(), 2, NOW()
      )
      ON CONFLICT (member_id, channel) WHERE member_id IS NOT NULL
      DO UPDATE SET destination_ciphertext=EXCLUDED.destination_ciphertext,
        destination_hash=EXCLUDED.destination_hash, destination_hint=EXCLUDED.destination_hint,
        verification_status='owner_verified', verification_source='owner_attestation',
        verified_by_user_id=EXCLUDED.verified_by_user_id, owner_consent_at=NOW(),
        owner_consent_version='support-notifications-v1', verified_at=NOW(), fingerprint_version=2,
        verification_code_hash=NULL, verification_expires_at=NULL, updated_at=NOW()
      RETURNING id
    `);
    const destinationId = Number((destination.rows[0] as { id?: number } | undefined)?.id || 0);
    if (!destinationId) throw new Error(`Unable to save the ${channel} notification destination.`);

    if (previous?.id && previous.destination_hash !== digest) {
      await tx.execute(sql`
        UPDATE support_member_notification_deliveries
        SET status='cancelled', updated_at=NOW(), error_code='DESTINATION_CHANGED',
          last_error='Notification destination changed before delivery.'
        WHERE user_id=${input.userId} AND destination_id=${Number(previous.id)}
          AND status IN ('pending','retry')
      `);
    }

    for (const event of MEMBER_NOTIFICATION_EVENTS) {
      const enabled = config.enabled && (input.events?.[event] ?? DEFAULT_ASSIGNED_MEMBER_EVENTS.has(event));
      await tx.execute(sql`
        INSERT INTO support_notification_preferences (
          user_id, team_id, member_id, event_type, channel, enabled, destination_id, updated_at
        ) VALUES (
          ${input.userId}, ${input.teamId}, ${input.memberId}, ${event}, ${channel}, ${enabled}, ${destinationId}, NOW()
        )
        ON CONFLICT (member_id, event_type, channel) WHERE member_id IS NOT NULL
        DO UPDATE SET enabled=EXCLUDED.enabled, destination_id=EXCLUDED.destination_id, updated_at=NOW()
      `);
    }

    await tx.execute(sql`
      INSERT INTO support_notification_audit_logs (
        user_id, member_id, actor_type, action, entity_type, entity_id, metadata, expires_at
      ) VALUES (
        ${input.userId}, ${input.memberId}, 'owner', 'destination.owner_verified',
        'support_notification_destination', ${destinationId},
        ${JSON.stringify({
          channel,
          destinationHint: supportNotificationDestinationHint(channel, config.destination),
          consentVersion: 'support-notifications-v1',
          enabled: config.enabled,
        })}::jsonb,
        NOW() + INTERVAL '365 days'
      )
    `);
  }
}
