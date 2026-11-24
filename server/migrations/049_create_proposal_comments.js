/**
 * Migration: create_proposal_comments
 * Creates proposal_comments table for proposal collaboration.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS proposal_comments (
      id SERIAL PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_comment_id INTEGER REFERENCES proposal_comments(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      mentions JSONB DEFAULT '[]'::jsonb,
      attachments JSONB DEFAULT '[]'::jsonb,
      is_resolved BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_comments_proposal_id ON proposal_comments(proposal_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_comments_user_id ON proposal_comments(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_comments_parent_id ON proposal_comments(parent_comment_id)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS proposal_comments CASCADE`);
}
