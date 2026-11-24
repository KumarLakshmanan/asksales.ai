/** Correct follow-up due times computed by parsing UTC database timestamps as local time. */
export async function up(client) {
  await client.query(`
    UPDATE social_follow_up_schedules AS schedule
    SET next_run_at = COALESCE(anchor.sent_at, anchor.created_at) + (
          COALESCE((schedule.steps->(schedule.next_step - 1)->>'delayDays')::numeric, 0) * 1440
        + COALESCE((schedule.steps->(schedule.next_step - 1)->>'delayHours')::numeric, 0) * 60
        + COALESCE((schedule.steps->(schedule.next_step - 1)->>'delayMinutes')::numeric, 0)
      ) * INTERVAL '1 minute',
        updated_at = NOW()
    FROM outreach_messages AS anchor
    WHERE anchor.id = schedule.anchor_message_id
      AND schedule.status = 'active'
      AND schedule.channel IN ('whatsapp', 'instagram', 'facebook')
      AND schedule.steps->(schedule.next_step - 1) IS NOT NULL
  `);
}

export async function down() {
  throw new Error('Corrected follow-up due times cannot be restored safely. Roll forward.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
