/**
 * Migration: add_user_approval
 * Source: migrations/add_user_approval.sql
 * Generated: 2026-03-06
 */

export async function up(client) {
    await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved boolean NOT NULL DEFAULT false
    `);

    // Set all existing users as approved (backward compatibility)
    await client.query(`
        UPDATE users SET is_approved = true WHERE is_approved = false
    `);
}

export async function down(client) {
    await client.query(`
        ALTER TABLE users DROP COLUMN IF EXISTS is_approved
    `);
}
