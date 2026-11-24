/**
 * Migration: create_tool_approvals
 * Creates the tool_approvals table for human-in-the-loop agent approvals
 */

export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS tool_approvals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id INTEGER,
    workflow_id VARCHAR(255),
    tool_name VARCHAR(255) NOT NULL,
    tool_args JSONB,
    agent_type VARCHAR(100),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    user_decision VARCHAR(50),
    user_comment TEXT,
    decided_at TIMESTAMP,
    execution_result JSONB,
    expires_at TIMESTAMP,
    is_expired BOOLEAN DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS tool_approvals`);
}
