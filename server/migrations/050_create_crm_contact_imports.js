/**
 * Migration: create_crm_contact_imports
 * Creates crm_contact_imports and crm_contact_import_details tables for CSV import.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_contact_imports (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name VARCHAR(500) NOT NULL,
      total_records INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      import_type VARCHAR(50) DEFAULT 'new',
      column_mapping JSONB DEFAULT '{}'::jsonb,
      import_status VARCHAR(50) NOT NULL DEFAULT 'queued',
      error_summary JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      uploaded_at TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_contact_import_details (
      id SERIAL PRIMARY KEY,
      import_id INTEGER NOT NULL REFERENCES crm_contact_imports(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      original_data JSONB,
      parsed_data JSONB,
      mapped_contact_data JSONB,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contact_imports_user_id ON crm_contact_imports(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contact_imports_status ON crm_contact_imports(import_status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contact_import_details_import_id ON crm_contact_import_details(import_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_contact_import_details_status ON crm_contact_import_details(status)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS crm_contact_import_details CASCADE`);
  await client.query(`DROP TABLE IF EXISTS crm_contact_imports CASCADE`);
}
