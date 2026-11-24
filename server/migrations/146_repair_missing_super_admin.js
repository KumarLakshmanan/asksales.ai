/**
 * Repair legacy installations created before the admin bootstrap flow assigned
 * the first account the super_admin role.
 *
 * Promotion is intentionally limited to databases with exactly one admin and
 * no existing super admin. Multi-admin installations require an explicit owner
 * selection and are therefore left unchanged.
 */

const REPAIR_TABLE = 'migration_146_super_admin_repair';

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${REPAIR_TABLE} (
      admin_id INTEGER PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
      previous_role VARCHAR(50) NOT NULL,
      promoted_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    WITH sole_legacy_admin AS (
      SELECT MIN(id) AS id
      FROM admins
      HAVING COUNT(*) = 1
        AND COUNT(*) FILTER (WHERE role = 'super_admin') = 0
    ), promoted AS (
      UPDATE admins AS admin
      SET role = 'super_admin', updated_at = NOW()
      FROM sole_legacy_admin
      WHERE admin.id = sole_legacy_admin.id
        AND admin.role = 'admin'
      RETURNING admin.id
    )
    INSERT INTO ${REPAIR_TABLE} (admin_id, previous_role)
    SELECT id, 'admin'
    FROM promoted
    ON CONFLICT (admin_id) DO NOTHING
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE admins AS admin
    SET role = repair.previous_role, updated_at = NOW()
    FROM ${REPAIR_TABLE} AS repair
    WHERE admin.id = repair.admin_id
      AND admin.role = 'super_admin'
  `);

  await client.query(`DROP TABLE IF EXISTS ${REPAIR_TABLE}`);
}
