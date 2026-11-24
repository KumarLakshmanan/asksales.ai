/**
 * Indexes for outreach message tracking, built CONCURRENTLY so sending and
 * webhook receipts keep writing to outreach_messages while they build.
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this migration
 * opts out of the runner's BEGIN/COMMIT. Every statement is safe to repeat: a
 * build that was interrupted leaves an INVALID index, which is dropped first.
 */
export const transaction = false;

const indexes = [
  // Counts and the status-filtered recipient list of one outreach.
  ['outreach_messages_batch_status_idx', `(batch_id,message_kind,status) WHERE batch_id IS NOT NULL`],
  // Paging and the CSV download of one outreach.
  ['outreach_messages_batch_id_idx', `(batch_id,id) WHERE batch_id IS NOT NULL`],
  // Day-by-day numbers across the business, one per timestamp.
  ['outreach_messages_outbound_sent_idx', `(business_profile_id,user_id,sent_at) WHERE direction='outbound' AND sent_at IS NOT NULL AND batch_id IS NOT NULL`],
  ['outreach_messages_outbound_delivered_idx', `(business_profile_id,user_id,delivered_at) WHERE direction='outbound' AND delivered_at IS NOT NULL AND batch_id IS NOT NULL`],
  ['outreach_messages_outbound_read_idx', `(business_profile_id,user_id,read_at) WHERE direction='outbound' AND read_at IS NOT NULL AND batch_id IS NOT NULL`],
  ['outreach_messages_outbound_failed_idx', `(business_profile_id,user_id,failed_at) WHERE direction='outbound' AND failed_at IS NOT NULL AND batch_id IS NOT NULL`],
  // The Coming up schedule: everything still waiting to be sent.
  ['outreach_messages_waiting_idx', `(business_profile_id,user_id) WHERE direction='outbound' AND status='pending'`],
  // Messages by template.
  ['outreach_messages_template_idx', `(business_profile_id,user_id,template_name,template_language) WHERE template_name IS NOT NULL AND batch_id IS NOT NULL`],
];

export async function up(client) {
  // A build on a large table can run longer than the runner's statement limit.
  await client.query('SET statement_timeout=0');
  try {
    for (const [name, definition] of indexes) {
      const invalid = await client.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1 AND NOT i.indisvalid`, [name]);
      if (invalid.rows.length) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON outreach_messages${definition}`);
    }
  } finally {
    await client.query('RESET statement_timeout');
  }
}

export async function down(client) {
  // Rollback runs inside the runner's transaction, where a plain DROP is the only form allowed.
  await client.query(`DROP INDEX IF EXISTS ${indexes.map(([name]) => name).join(',')}`);
}
