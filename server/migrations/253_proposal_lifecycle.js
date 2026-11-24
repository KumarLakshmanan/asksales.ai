export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS proposal_review_policies (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS proposal_approvals (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      reviewer_member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      fingerprint VARCHAR(64) NOT NULL, snapshot JSONB NOT NULL,
      decision VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','changes_requested')),
      comment TEXT, reviewed_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,proposal_id,reviewer_member_id,fingerprint));
    CREATE INDEX IF NOT EXISTS proposal_approvals_queue ON proposal_approvals(user_id,reviewer_member_id,decision);
    ALTER TABLE proposal_feedback ADD COLUMN IF NOT EXISTS request_key VARCHAR(100);
    ALTER TABLE proposal_feedback ADD COLUMN IF NOT EXISTS parent_feedback_id INTEGER REFERENCES proposal_feedback(id) ON DELETE SET NULL;
    ALTER TABLE proposal_feedback ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
    CREATE UNIQUE INDEX IF NOT EXISTS proposal_feedback_request ON proposal_feedback(user_id,proposal_id,request_key) WHERE request_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS proposal_feedback_parent ON proposal_feedback(user_id,proposal_id,parent_feedback_id) WHERE parent_feedback_id IS NOT NULL;
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES proposals(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS proposals_superseded ON proposals(user_id,superseded_by) WHERE superseded_by IS NOT NULL;
    ALTER TABLE proposal_reminders ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
    CREATE OR REPLACE FUNCTION pause_proposal_followups_on_customer_reply() RETURNS trigger AS $$
    BEGIN
      IF NEW.direction = 'inbound' THEN
        UPDATE proposal_reminders reminder SET status='paused',last_sent_at=NULL,updated_at=NOW(),
          metadata=COALESCE(reminder.metadata,'{}'::jsonb)||jsonb_build_object('pauseReason','customer_reply','pausedAt',NOW())
        FROM proposals proposal
        WHERE proposal.id=reminder.proposal_id AND proposal.user_id=reminder.user_id
          AND proposal.outreach_conversation_id=NEW.conversation_id AND proposal.user_id=NEW.user_id
          AND reminder.reminder_type='customer_followup' AND reminder.status IN ('pending','snoozed');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS outreach_reply_pause_proposal_followups ON outreach_messages;
    CREATE TRIGGER outreach_reply_pause_proposal_followups AFTER INSERT ON outreach_messages
      FOR EACH ROW EXECUTE FUNCTION pause_proposal_followups_on_customer_reply();
  `);
}
export async function down(client) { await client.query('SELECT 1'); }
