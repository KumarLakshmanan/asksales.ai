import { proposalStarterTemplates } from "../data/proposalStarterTemplates.js";
export async function up(client) {
  await client.query(`
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE proposal_templates ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS template_key VARCHAR(100);
    ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    CREATE UNIQUE INDEX IF NOT EXISTS proposal_templates_global_key ON proposal_templates(template_key) WHERE user_id IS NULL;
    CREATE TABLE IF NOT EXISTS proposal_events (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL UNIQUE, kind VARCHAR(50) NOT NULL, payload JSONB NOT NULL DEFAULT '{}',
      processed_at TIMESTAMP, last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(), created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS proposal_events_pending ON proposal_events(created_at) WHERE processed_at IS NULL;
    CREATE TABLE IF NOT EXISTS proposal_catalog (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, description TEXT NOT NULL DEFAULT '', currency VARCHAR(3) NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL CHECK(unit_price >= 0), unit VARCHAR(50) NOT NULL DEFAULT 'unit',
      active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS proposal_versions (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      snapshot JSONB NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS proposal_versions_proposal ON proposal_versions(user_id, proposal_id, id);
    CREATE TABLE IF NOT EXISTS proposal_template_audit (
      id SERIAL PRIMARY KEY, template_id INTEGER, admin_id INTEGER, action TEXT NOT NULL,
      snapshot JSONB NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION proposal_capture_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO proposal_events (user_id,proposal_id,event_key,kind,payload)
        VALUES (NEW.user_id,NEW.id,NEW.id::text || ':' || NEW.status || ':' || clock_timestamp()::text,
          CASE WHEN TG_OP='INSERT' THEN 'created' ELSE NEW.status END,
          (to_jsonb(NEW) - 'public_token_hash' - 'public_token_expires_at') || jsonb_build_object('line_items', (SELECT COALESCE(jsonb_agg(to_jsonb(li) ORDER BY li.sort_order),'[]'::jsonb) FROM proposal_line_items li WHERE li.proposal_id=NEW.id)));
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS proposal_capture_event_trigger ON proposals;
    CREATE TRIGGER proposal_capture_event_trigger AFTER INSERT OR UPDATE OF status ON proposals
      FOR EACH ROW EXECUTE FUNCTION proposal_capture_event();
  `);
  for (const t of proposalStarterTemplates) {
    await client.query(
      `INSERT INTO proposal_templates (user_id, template_key, name, description, template_type, published, template_content)
      VALUES (NULL,$1,$2,$3,'document',TRUE,$4::jsonb) ON CONFLICT (template_key) WHERE user_id IS NULL DO NOTHING`,
      [t.key, t.name, t.description, JSON.stringify(t.templateContent)],
    );
  }
}
export async function down(client) {
  await client.query(
    `DROP TRIGGER IF EXISTS proposal_capture_event_trigger ON proposals; DROP FUNCTION IF EXISTS proposal_capture_event()`,
  );
  await client.query(
    `DROP TABLE IF EXISTS proposal_template_audit, proposal_versions, proposal_catalog, proposal_events`,
  );
  // Preserve templates referenced by customer proposals when rolling back.
}
