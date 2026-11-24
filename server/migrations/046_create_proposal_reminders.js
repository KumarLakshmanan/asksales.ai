/**
 * Migration: create_proposal_reminders
 * Creates proposal_reminders table for expiry and custom reminders.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS proposal_reminders (
      id SERIAL PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reminder_due_at TIMESTAMP NOT NULL,
      sent_at TIMESTAMP,
      reminder_type VARCHAR(50) NOT NULL DEFAULT 'expiry',
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      snoozed_until TIMESTAMP,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_reminders_proposal_id ON proposal_reminders(proposal_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_reminders_user_id ON proposal_reminders(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_reminders_status ON proposal_reminders(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_reminders_due_at ON proposal_reminders(reminder_due_at)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS proposal_reminders CASCADE`);
}
