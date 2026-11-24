/**
 * Harden support-ticket and support-member invariants.
 *
 * The legacy (team_id, user_id) member index treated the workspace owner as
 * the individual agent and prevented more than one portal member per team.
 * Portal login is email-only, so active email identities must instead be
 * globally unambiguous.
 */
export async function up(client) {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM team_members
        WHERE email IS NOT NULL
        GROUP BY LOWER(BTRIM(email))
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Duplicate support-member emails must be reconciled before migration 133 can run';
      END IF;
    END $$;

    UPDATE team_members
    SET email = LOWER(BTRIM(email)),
        role = CASE WHEN role IN ('member', 'lead', 'admin') THEN role ELSE 'member' END
    WHERE email IS NOT NULL OR role NOT IN ('member', 'lead', 'admin');

    DROP INDEX IF EXISTS idx_team_members_unique;
    DROP INDEX IF EXISTS idx_team_members_email_unique;
    CREATE UNIQUE INDEX idx_team_members_email_unique
      ON team_members (LOWER(email))
      WHERE email IS NOT NULL;

    ALTER TABLE team_members
      DROP CONSTRAINT IF EXISTS team_members_role_check;
    ALTER TABLE team_members
      ADD CONSTRAINT team_members_role_check
      CHECK (role IN ('member', 'lead', 'admin'));

    UPDATE support_tickets
    SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('legacyStatusBeforeMigration133', status),
        status = 'open'
    WHERE status NOT IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed');

    UPDATE support_tickets
    SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('legacyPriorityBeforeMigration133', priority),
        priority = 'medium'
    WHERE priority NOT IN ('low', 'medium', 'high', 'urgent', 'critical');

    ALTER TABLE support_tickets
      DROP CONSTRAINT IF EXISTS support_tickets_status_check;
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_status_check
      CHECK (status IN ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'));

    ALTER TABLE support_tickets
      DROP CONSTRAINT IF EXISTS support_tickets_priority_check;
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'urgent', 'critical'));

    ALTER TABLE support_ticket_messages
      DROP CONSTRAINT IF EXISTS support_ticket_messages_direction_check;
    ALTER TABLE support_ticket_messages
      ADD CONSTRAINT support_ticket_messages_direction_check
      CHECK (direction IN ('inbound', 'outbound'));
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE support_ticket_messages
      DROP CONSTRAINT IF EXISTS support_ticket_messages_direction_check;
    ALTER TABLE support_tickets
      DROP CONSTRAINT IF EXISTS support_tickets_priority_check;
    ALTER TABLE support_tickets
      DROP CONSTRAINT IF EXISTS support_tickets_status_check;
    ALTER TABLE team_members
      DROP CONSTRAINT IF EXISTS team_members_role_check;

    DROP INDEX IF EXISTS idx_team_members_email_unique;
    CREATE INDEX IF NOT EXISTS idx_team_members_unique
      ON team_members (team_id, user_id);
  `);
}
