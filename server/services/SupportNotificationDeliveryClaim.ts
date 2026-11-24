import { sql } from 'drizzle-orm';

/** Claim against current authorization, not the earlier event snapshot.
 * This runs inside the caller's tenant-scoped transaction. Accepted/uncertain
 * submissions are never reclaimed. A queued alert whose authority was revoked
 * becomes suppressed instead of waiting to send after a future re-enable.
 */
export function supportNotificationDeliveryClaim(userId: number, deliveryId: number) {
  return sql`
    WITH candidate AS (
      SELECT d.id, (d.channel NOT IN ('email','whatsapp') OR EXISTS (
        SELECT 1 FROM team_members m
        JOIN support_teams team ON team.id=m.team_id AND team.user_id=m.user_id AND team.is_active IS TRUE
        JOIN support_notification_channel_settings settings
          ON settings.user_id=m.user_id AND settings.channel=d.channel AND settings.enabled IS TRUE
        JOIN support_notification_destinations destination
          ON destination.user_id=m.user_id AND destination.member_id=m.id
          AND destination.id=d.destination_id AND destination.channel=d.channel
          AND destination.verification_status IN ('verified','owner_verified')
          AND destination.destination_ciphertext=d.recipient_ciphertext
        WHERE m.user_id=d.user_id AND m.id=d.member_id AND m.is_active IS TRUE
          AND (
            (d.event_id IS NULL AND d.event_key LIKE 'support-notification-test:%')
            OR EXISTS (
              SELECT 1 FROM support_notification_events event
              JOIN support_tickets ticket ON ticket.id=event.ticket_id AND ticket.user_id=event.user_id
              WHERE event.id=d.event_id AND event.user_id=d.user_id
                AND ticket.assigned_member_id=m.id AND ticket.team_id=m.team_id
                AND ticket.deleted_at IS NULL AND ticket.status NOT IN ('closed','resolved')
            )
          )
      )) AS eligible
      FROM support_member_notification_deliveries d
      WHERE d.id=${deliveryId} AND d.user_id=${userId}
        AND d.attempt_count < d.max_attempts AND d.next_attempt_at <= NOW()
        AND d.status IN ('pending','retry')
      FOR UPDATE OF d
    )
    UPDATE support_member_notification_deliveries d
    SET status=CASE WHEN candidate.eligible THEN 'sending' ELSE 'suppressed' END,
      attempt_count=d.attempt_count + CASE WHEN candidate.eligible THEN 1 ELSE 0 END,
      updated_at=NOW(),
      last_error=CASE WHEN candidate.eligible THEN NULL ELSE 'Notification authorization changed before delivery.' END,
      error_code=CASE WHEN candidate.eligible THEN NULL ELSE 'DELIVERY_AUTHORIZATION_REVOKED' END
    FROM candidate WHERE d.id=candidate.id AND d.user_id=${userId}
    RETURNING d.*
  `;
}
