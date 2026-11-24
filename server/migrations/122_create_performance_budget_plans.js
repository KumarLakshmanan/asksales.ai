/**
 * Migration 122: Persist performance-marketing budget plans through migrations.
 *
 * Older code attempted to create this table inside a user request. Keeping the
 * DDL here makes deployment repeatable, reviewable, and reversible.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS performance_budget_plans (
      id SERIAL PRIMARY KEY,
      icp_id INTEGER NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
      total_budget NUMERIC(12, 2) NOT NULL CHECK (total_budget > 0),
      duration_days INTEGER NOT NULL CHECK (duration_days > 0),
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      channel_allocation JSONB NOT NULL DEFAULT '[]'::jsonb,
      daily_budget NUMERIC(12, 2) NOT NULL DEFAULT 0,
      recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_performance_budget_plans_icp_created
    ON performance_budget_plans(icp_id, created_at DESC)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS performance_budget_plans`);
}
