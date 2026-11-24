/** Composite indexes for paginated Support AI reporting and answer-quality review. */
export async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_support_chat_sessions_reporting
      ON support_chat_sessions(business_profile_id,member_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_support_chat_messages_timeline
      ON support_chat_messages(session_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_support_chat_messages_staff_feedback
      ON support_chat_messages(business_profile_id,created_at DESC,id DESC)
      WHERE role='assistant' AND metadata #>> '{staffFeedback,rating}' IN ('helpful','needs_review');
    CREATE INDEX IF NOT EXISTS idx_support_widget_leads_reporting
      ON leads(business_profile_id,user_id,created_at DESC,id DESC)
      WHERE source='support_widget' AND deleted_at IS NULL;
  `);
}
export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS idx_support_widget_leads_reporting;
    DROP INDEX IF EXISTS idx_support_chat_messages_staff_feedback;
    DROP INDEX IF EXISTS idx_support_chat_messages_timeline;
    DROP INDEX IF EXISTS idx_support_chat_sessions_reporting;
  `);
}
