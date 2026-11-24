/**
 * Migration: 0005_faithful_squadron_supreme
 * Source: migrations/0005_faithful_squadron_supreme.sql
 * Generated: 2026-03-06T08:18:40.939Z
 */

export async function up(client) {
    await client.query(`ALTER TABLE "agent_executions" ALTER COLUMN "id" DROP DEFAULT`);

    await client.query(`ALTER TABLE "agents" ALTER COLUMN "id" DROP DEFAULT`);

    await client.query(`ALTER TABLE "approval_checkpoints" ALTER COLUMN "id" DROP DEFAULT`);

    await client.query(`ALTER TABLE "icp_profiles" ALTER COLUMN "uuid" DROP DEFAULT`);

    await client.query(`ALTER TABLE "leads" ALTER COLUMN "uuid" DROP DEFAULT`);

    await client.query(`ALTER TABLE "scraping_progress" ALTER COLUMN "id" DROP DEFAULT`);

    await client.query(`ALTER TABLE "workflow_sessions" ALTER COLUMN "id" DROP DEFAULT`);
}

export async function down(client) {
  // Rollback for this migration
  // NOTE: Auto-generated down() is a no-op. Add rollback SQL manually if needed.
  console.log('  (no automatic rollback for 0005_faithful_squadron_supreme)');
}
