/**
 * Migration: enable_pgcrypto
 * Source: migrations/0000_enable_pgcrypto.sql
 * Generated: 2026-03-06
 */

export async function up(client) {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
}

export async function down(client) {
    // Don't drop pgcrypto — other tables/features might depend on it
    console.log('  (pgcrypto extension kept — manual removal only)');
}
