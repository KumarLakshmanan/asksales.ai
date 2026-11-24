import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/** Run before accepting traffic or starting workers. A new table must declare
 * whether it belongs to an account or a business before runtime access is granted. */
export async function assertBusinessScopeSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  const installed = await pool.query("SELECT to_regclass('public.business_scope_tables') AS business, to_regclass('public.business_scope_accounts') AS account");
  if (!installed.rows[0]?.business || !installed.rows[0]?.account) {
    throw new Error('Apply migration 299_business_profile_isolation before starting the application.');
  }
  const result = await pool.query(`SELECT c.relname AS table_name,
    CASE WHEN b.table_name IS NULL AND a.table_name IS NULL THEN 'unclassified table'
      ELSE 'missing business isolation policy or ownership trigger' END AS reason
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN public.business_scope_tables b ON b.table_name=c.relname
    LEFT JOIN public.business_scope_accounts a ON a.table_name=c.relname
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (
      (b.table_name IS NULL AND a.table_name IS NULL) OR (b.table_name IS NOT NULL AND (
        NOT c.relrowsecurity OR NOT c.relforcerowsecurity
        OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='business_isolation')
        OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='business_ownership_guard' AND t.tgenabled='O')
        OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND p.prosecdef)
      ))) ORDER BY c.relname`);
  if (result.rows.length) throw new Error(`Database business ownership is incomplete: ${result.rows.map(row => `${row.table_name} (${row.reason})`).join(', ')}`);
  const role = await pool.query("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='salesmarketing_business_runtime'");
  if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].rolcanlogin) {
    throw new Error('The business runtime database role must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS.');
  }
  // Every application query runs as the runtime role. A dump restored without privileges
  // (pg_restore --no-acl / --no-privileges) keeps the tables but drops these grants, and
  // then every scoped query fails at runtime. Stop at startup with the repair instead.
  const privileges = await pool.query(`SELECT c.relname AS table_name,
      has_table_privilege('salesmarketing_business_runtime', c.oid, 'SELECT') AS readable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('__drizzle_migrations', 'js_migrations')
      AND (EXISTS(SELECT 1 FROM public.business_scope_tables b WHERE b.table_name=c.relname)
        OR EXISTS(SELECT 1 FROM public.business_scope_accounts a WHERE a.table_name=c.relname))
    ORDER BY c.relname`);
  const names = privileges.rows.filter(row => !row.readable).map(row => row.table_name as string);
  if (!names.length) return;
  const message = `The business runtime role cannot read ${names.length} of ${privileges.rows.length} application tables `
    + `(${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}). Restored dumps lose these grants; re-apply them with `
    + '`node scripts/copy-runtime-grants.mjs --from <migrated database> --to <this database>`.';
  // A restore without privileges leaves almost nothing readable: refuse to start. A few
  // missing grants only break those tables, so report them without taking the app down.
  if (names.length * 2 >= privileges.rows.length) throw new Error(message);
  logger.warn({ tables: names }, `[schemaGuard] ${message}`);
}
