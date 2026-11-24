// The queued outreach sender recorded every provider attempt in sent_messages
// without the outreach message it belonged to. When Meta rejected a WhatsApp
// message and it was retried, each attempt looked like a separate legacy send,
// so campaign reports counted one message many times (about 33,000 extra on one
// account). The worker now links new attempts. This links the old ones.
//
// An attempt is linked only when exactly one outbound outreach message matches:
// the same contact's conversation on the same channel, the same text, created
// no later than the attempt. Anything ambiguous is left as it is.
export async function up(client) {
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  await client.query(`
    WITH attempt AS (
      SELECT s.id, s.user_id, s.business_profile_id, s.lead_id, s.channel, s.sent_at, s.message
        FROM sent_messages s
       WHERE s.outreach_message_id IS NULL AND s.is_reply IS NOT TRUE
         AND s.channel NOT IN ('email','gmail','resend')
         AND s.lead_id IS NOT NULL AND s.message IS NOT NULL AND s.sent_at IS NOT NULL
    ), candidate AS (
      SELECT a.id AS sent_id, min(m.id) AS message_id, count(*) AS matches
        FROM attempt a
        JOIN outreach_conversations c ON c.user_id = a.user_id AND c.lead_id = a.lead_id AND c.channel = a.channel
         AND c.business_profile_id IS NOT DISTINCT FROM a.business_profile_id
        JOIN outreach_messages m ON m.conversation_id = c.id AND m.user_id = a.user_id
         AND m.direction = 'outbound' AND m.message_kind IN ('outreach','follow_up')
         AND m.created_at <= a.sent_at AND m.content = a.message
       GROUP BY a.id
    )
    UPDATE sent_messages s SET outreach_message_id = candidate.message_id, updated_at = NOW()
      FROM candidate
     WHERE s.id = candidate.sent_id AND candidate.matches = 1 AND s.outreach_message_id IS NULL
  `);
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
}

// Links record which message each attempt belonged to. Removing them would
// bring back the double counting, so rollback leaves them in place.
export async function down(client) {
  await client.query('SELECT 1');
}
