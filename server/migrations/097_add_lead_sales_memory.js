/**
 * Migration 097: cross-conversation customer memory + lead intelligence for the
 * WhatsApp Sales Agent. One JSONB column on leads holds the durable customer
 * profile (name, budget, preferred room, travel reason, booking stage, last
 * dates, concerns, negative-interaction count) and the latest lead-intelligence
 * snapshot (score, booking probability, urgency, value, likely concern).
 */

export async function up(client) {
  await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales_memory JSONB DEFAULT '{}'::jsonb`);
}

export async function down(client) {
  await client.query(`ALTER TABLE leads DROP COLUMN IF EXISTS sales_memory`);
}
