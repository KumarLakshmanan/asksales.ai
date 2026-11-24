/**
 * Migration: create_crm_activity_reminders
 * Creates crm_activity_reminders table for general activity reminders.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_activity_reminders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_id INTEGER REFERENCES crm_activities(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      reminder_due_at TIMESTAMP NOT NULL,
      reminder_type VARCHAR(50) NOT NULL DEFAULT 'followup',
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      title VARCHAR(500),
      description TEXT,
      sent_at TIMESTAMP,
      snoozed_until TIMESTAMP,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_reminders_user_id ON crm_activity_reminders(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_reminders_status ON crm_activity_reminders(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_reminders_due_at ON crm_activity_reminders(reminder_due_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_activity_reminders_contact_id ON crm_activity_reminders(contact_id)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS crm_activity_reminders CASCADE`);
}
