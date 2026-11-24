/**
 * Privacy-vault views can be performed by either a support team member or the
 * authenticated workspace owner. Owner views are identified in audit metadata,
 * so they do not have a team_members row to reference.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE support_privacy_access_logs
      ALTER COLUMN member_id DROP NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM support_privacy_access_logs WHERE member_id IS NULL) THEN
        RAISE EXCEPTION 'Cannot restore member_id NOT NULL while owner privacy access audits exist';
      END IF;
    END $$;

    ALTER TABLE support_privacy_access_logs
      ALTER COLUMN member_id SET NOT NULL;
  `);
}
