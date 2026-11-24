/**
 * Migration: admin_api_credentials
 * Source: migrations/0006_create_admin_api_credentials.sql
 * Generated: 2026-03-06
 */

export async function up(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS admin_api_credentials (
            id SERIAL PRIMARY KEY,
            platform VARCHAR(50) NOT NULL,
            name VARCHAR(255) NOT NULL,
            api_key TEXT NOT NULL,
            api_secret TEXT,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            priority VARCHAR(20) NOT NULL DEFAULT 'normal',
            config JSONB DEFAULT '{}',
            last_used_at TIMESTAMP,
            usage_count VARCHAR(50) DEFAULT '0',
            deactivation_reason VARCHAR(100),
            deactivated_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_api_credentials_platform ON admin_api_credentials(platform)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_api_credentials_active ON admin_api_credentials(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_api_credentials_priority ON admin_api_credentials(priority)`);
}

export async function down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_admin_api_credentials_priority`);
    await client.query(`DROP INDEX IF EXISTS idx_admin_api_credentials_active`);
    await client.query(`DROP INDEX IF EXISTS idx_admin_api_credentials_platform`);
    await client.query(`DROP TABLE IF EXISTS admin_api_credentials`);
}
