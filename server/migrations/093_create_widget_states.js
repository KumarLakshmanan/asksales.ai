/**
 * Migration: create_widget_states
 * Creates the widget_states table for interactive chat widget persistence
 */

export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS widget_states (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    message_id INTEGER REFERENCES chat_messages(id),
    tool_name VARCHAR(255) NOT NULL,
    widget_type VARCHAR(100) NOT NULL,
    form_values JSONB DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    submitted_at TIMESTAMP,
    submitted_values JSONB,
    agent_type VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE INDEX idx_widget_states_thread ON widget_states(thread_id)`);
  await client.query(`CREATE INDEX idx_widget_states_user ON widget_states(user_id)`);
  await client.query(`CREATE INDEX idx_widget_states_status ON widget_states(status)`);
  await client.query(`CREATE INDEX idx_widget_states_message ON widget_states(message_id)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS widget_states`);
}
