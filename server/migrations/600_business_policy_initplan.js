// Every business_isolation policy called app_business_access(business_profile_id)
// once per row. The function is SECURITY DEFINER with its own search_path, so
// PostgreSQL never inlines it and repeats its ownership and membership lookups
// for each row it reads: counting one account's 42,000 outreach messages took
// 1.8 s instead of 14 ms, and campaign reports that scan several such tables
// came close to the 25 s request timeout. The planner also assumed only a third
// of the rows pass the check, which compounded into poor join estimates.
//
// The access decision depends only on the scope settings, not on the row. The
// policies now compare the row's business to the scoped business directly and
// check access once per statement, through an uncorrelated sub-select that
// PostgreSQL evaluates once (an InitPlan):
//
//   app_business_system() OR (business_profile_id = app_business_profile_id()
//     AND (SELECT app_business_access(app_business_profile_id())))
//
// This allows exactly the rows the old policy allowed: system scope still sees
// everything; otherwise a row must belong to the scoped business and the
// signed-in actor must still be its owner or an active member. Only policies
// still in the original form are changed, so this is safe to run again.
//
// New business tables should use the same expression in their policy.
const ORIGINAL = 'app_business_access(business_profile_id)';
const ONCE_PER_STATEMENT = 'app_business_system() OR (business_profile_id=app_business_profile_id() AND (SELECT app_business_access(app_business_profile_id())))';

async function rewrite(client, from, to) {
  // `from` is compared with PostgreSQL's own rendering of the stored policy.
  const result = await client.query(`
    SELECT p.tablename FROM pg_policies p
     WHERE p.schemaname='public' AND p.policyname='business_isolation'
       AND p.qual=$1 AND p.with_check=$1
     ORDER BY p.tablename`, [from]);
  for (const { tablename } of result.rows) {
    await client.query(`ALTER POLICY business_isolation ON public.${quote(tablename)} USING (${to}) WITH CHECK (${to})`);
  }
  return result.rows.length;
}

function quote(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function rendered(client, expression) {
  // How PostgreSQL prints the new expression in pg_policies, for down().
  await client.query(`CREATE TEMP TABLE business_policy_render(business_profile_id integer) ON COMMIT DROP`);
  await client.query(`CREATE POLICY render ON business_policy_render USING (${expression})`);
  const result = await client.query(`SELECT qual FROM pg_policies WHERE tablename='business_policy_render' AND policyname='render'`);
  await client.query(`DROP TABLE business_policy_render`);
  return result.rows[0].qual;
}

export async function up(client) {
  await rewrite(client, ORIGINAL, ONCE_PER_STATEMENT);
}

export async function down(client) {
  await rewrite(client, await rendered(client, ONCE_PER_STATEMENT), ORIGINAL);
}
