/**
 * Owner-facing Support AI creates an internal team member that has no portal
 * login identity. The Drizzle schema and the partial unique email index already
 * allow that representation, but the original production column still carried
 * its legacy NOT NULL constraint.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE team_members
      ALTER COLUMN email DROP NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM team_members WHERE email IS NULL) THEN
        RAISE EXCEPTION 'Cannot restore team_members.email NOT NULL while session-only members exist';
      END IF;
    END $$;

    ALTER TABLE team_members
      ALTER COLUMN email SET NOT NULL;
  `);
}
