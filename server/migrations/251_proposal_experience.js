export async function up(client) {
  await client.query(`
    ALTER TABLE proposal_line_items
      ADD COLUMN IF NOT EXISTS catalog_id INTEGER REFERENCES proposal_catalog(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS is_complimentary BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS price_confirmed BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS is_optional BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS selected BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS package_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS billing_period VARCHAR(20) NOT NULL DEFAULT 'one_time';
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS draft_key VARCHAR(100);
    CREATE UNIQUE INDEX IF NOT EXISTS proposals_user_draft_key ON proposals(user_id,draft_key) WHERE draft_key IS NOT NULL;
    ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'General';
    CREATE TABLE IF NOT EXISTS proposal_template_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      template_id INTEGER NOT NULL REFERENCES proposal_templates(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,template_id));
    CREATE TABLE IF NOT EXISTS proposal_feedback (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      kind VARCHAR(30) NOT NULL CHECK(kind IN ('question','change_request','seller_reply')),
      author_name VARCHAR(255), content TEXT NOT NULL, resolved_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS proposal_feedback_proposal ON proposal_feedback(user_id,proposal_id,id);
  `);
  // Existing drafts with a zero rate need an explicit complimentary decision. Agreed proposals remain unchanged.
  await client.query(`UPDATE proposal_line_items i SET price_confirmed=FALSE FROM proposals p WHERE p.id=i.proposal_id AND p.status='draft' AND i.unit_price=0 AND NOT i.is_complimentary`);
}

export async function down(client) {
  // Intentionally preserve proposal data and feedback. Reverting the application does not erase customer decisions.
  await client.query('SELECT 1');
}
