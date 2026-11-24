/**
 * Assigned-member support notifications.
 *
 * Keeps the durable v2 notification outbox, adds owner-attested destinations,
 * tenant-scoped WhatsApp template bindings, and provider submission state.
 */

const EVENT_TYPES = [
  'ticket_created_unassigned',
  'ticket_assigned',
  'ticket_reassigned',
  'human_handoff',
  'customer_replied',
  'ticket_reopened',
  'sla_at_risk',
  'sla_breached',
  'approval_required',
  'delivery_failed',
  'ticket_resolved',
];

const DEFAULT_ASSIGNMENT_SUBJECT = '{{event_title}} · {{ticket_number}}';
const DEFAULT_ASSIGNMENT_TEXT = `{{event_title}}

Ticket: {{ticket_number}}
Priority: {{priority}}
Source: {{source_channel}}
Issue: {{safe_summary}}
Required action: {{required_action}}
Response target: {{response_target}}

Open ticket: {{ticket_url}}`;

export async function up(client) {
  await client.query(`
    ALTER TABLE support_notification_destinations
      DROP CONSTRAINT IF EXISTS support_notification_destinations_verification_status_check,
      DROP CONSTRAINT IF EXISTS support_notification_destinations_verification_source_check
  `);
  await client.query(`
    ALTER TABLE support_notification_destinations
      ADD COLUMN IF NOT EXISTS verification_source VARCHAR(30),
      ADD COLUMN IF NOT EXISTS verified_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS owner_consent_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS owner_consent_version VARCHAR(40),
      ADD CONSTRAINT support_notification_destinations_verification_status_check
        CHECK (verification_status IN ('unverified', 'pending', 'verified', 'owner_verified', 'failed')),
      ADD CONSTRAINT support_notification_destinations_verification_source_check
        CHECK (verification_source IS NULL OR verification_source IN ('otp', 'owner_attestation', 'migration'))
  `);

  await client.query(`
    ALTER TABLE whatsapp_templates
      ADD COLUMN IF NOT EXISTS submission_status VARCHAR(30) NOT NULL DEFAULT 'local_draft',
      ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS meta_rejection_reason TEXT
  `);
  // A schema sync or a newer migration may already have installed a wider
  // lifecycle constraint. Preserve it, including uncertain provider states.
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'whatsapp_templates'::regclass
          AND conname = 'whatsapp_templates_submission_status_check'
      ) THEN
        ALTER TABLE whatsapp_templates
          ADD CONSTRAINT whatsapp_templates_submission_status_check
          CHECK (submission_status IN ('local_draft', 'submitted', 'pending', 'approved', 'rejected', 'paused', 'disabled'));
      END IF;
    END $$
  `);
  await client.query(`
    UPDATE whatsapp_templates SET submission_status = CASE
      WHEN UPPER(COALESCE(meta_status, status, '')) = 'APPROVED' THEN 'approved'
      WHEN UPPER(COALESCE(meta_status, status, '')) = 'REJECTED' THEN 'rejected'
      WHEN UPPER(COALESCE(meta_status, status, '')) = 'PAUSED' THEN 'paused'
      WHEN UPPER(COALESCE(meta_status, status, '')) = 'DISABLED' THEN 'disabled'
      WHEN waba_template_id IS NOT NULL THEN 'pending'
      ELSE 'local_draft' END
    WHERE submission_status = 'local_draft'
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_provider_bindings (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES support_teams(id) ON DELETE CASCADE,
      event_type VARCHAR(40) NOT NULL,
      channel VARCHAR(24) NOT NULL DEFAULT 'whatsapp',
      whatsapp_template_id INTEGER NOT NULL REFERENCES whatsapp_templates(id) ON DELETE RESTRICT,
      language VARCHAR(50) NOT NULL,
      variable_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_notification_provider_bindings_event_check
        CHECK (event_type IN (${EVENT_TYPES.map((value) => `'${value}'`).join(', ')})),
      CONSTRAINT support_notification_provider_bindings_channel_check CHECK (channel = 'whatsapp')
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_provider_bindings_scope_uq
      ON support_notification_provider_bindings(user_id, team_id, event_type, channel) NULLS NOT DISTINCT
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_notification_provider_bindings_template_idx
      ON support_notification_provider_bindings(user_id, whatsapp_template_id)
  `);

  await client.query(`
    INSERT INTO support_notification_templates (
      user_id, team_id, event_type, channel, locale, audience, name,
      status, active_version, managed_key, created_at, updated_at
    )
    SELECT DISTINCT tm.user_id, NULL::INTEGER, 'ticket_assigned', 'email', 'en-IN', 'member',
      'Default ticket assignment email', 'published', 1,
      'managed.support.ticket_assigned.email.v1', NOW(), NOW()
    FROM team_members tm
    ON CONFLICT (user_id, team_id, event_type, channel, locale, audience)
      DO NOTHING
  `);
  await client.query(`
    INSERT INTO support_notification_template_versions (
      user_id, template_id, version, subject_template, text_template,
      html_template, allowed_variables, checksum, published_at, created_at
    )
    SELECT t.user_id, t.id, 1, $1::TEXT, $2::TEXT, NULL,
      ARRAY['event_title','ticket_number','priority','source_channel','safe_summary','required_action','response_target','ticket_url']::TEXT[],
      md5($1::TEXT || E'\n' || $2::TEXT) || md5($2::TEXT || E'\nv1'), NOW(), NOW()
    FROM support_notification_templates t
    WHERE t.managed_key = 'managed.support.ticket_assigned.email.v1'
      AND NOT EXISTS (
        SELECT 1 FROM support_notification_template_versions v
        WHERE v.template_id = t.id AND v.version = 1
      )
  `, [DEFAULT_ASSIGNMENT_SUBJECT, DEFAULT_ASSIGNMENT_TEXT]);

  await client.query(`ALTER TABLE support_notification_provider_bindings ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE support_notification_provider_bindings FORCE ROW LEVEL SECURITY`);
  await client.query(`DROP POLICY IF EXISTS support_notification_provider_bindings_tenant_policy ON support_notification_provider_bindings`);
  await client.query(`
    CREATE POLICY support_notification_provider_bindings_tenant_policy
      ON support_notification_provider_bindings
      USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER)
      WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER)
  `);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_notification_provider_bindings');
  await client.query(`ALTER TABLE whatsapp_templates
    DROP CONSTRAINT IF EXISTS whatsapp_templates_submission_status_check,
    DROP COLUMN IF EXISTS meta_rejection_reason,
    DROP COLUMN IF EXISTS submitted_at,
    DROP COLUMN IF EXISTS submission_status`);
  await client.query(`ALTER TABLE support_notification_destinations
    DROP CONSTRAINT IF EXISTS support_notification_destinations_verification_source_check,
    DROP CONSTRAINT IF EXISTS support_notification_destinations_verification_status_check,
    DROP COLUMN IF EXISTS owner_consent_version,
    DROP COLUMN IF EXISTS owner_consent_at,
    DROP COLUMN IF EXISTS verified_by_user_id,
    DROP COLUMN IF EXISTS verification_source,
    ADD CONSTRAINT support_notification_destinations_verification_status_check
      CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed'))`);
}
