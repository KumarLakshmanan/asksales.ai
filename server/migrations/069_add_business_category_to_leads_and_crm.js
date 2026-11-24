export async function up(client) {
  await client.query(`
    ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS business_category_id INTEGER,
    ADD COLUMN IF NOT EXISTS business_category_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS business_subcategory_id INTEGER,
    ADD COLUMN IF NOT EXISTS business_subcategory_name VARCHAR(255);
  `);

  await client.query(`
    ALTER TABLE crm_contacts
    ADD COLUMN IF NOT EXISTS business_category_id INTEGER,
    ADD COLUMN IF NOT EXISTS business_category_name VARCHAR(255);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_leads_business_category_id ON leads(business_category_id);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_business_category_id ON crm_contacts(business_category_id);
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS idx_leads_business_category_id;
    DROP INDEX IF EXISTS idx_crm_contacts_business_category_id;
  `);

  await client.query(`
    ALTER TABLE leads
    DROP COLUMN IF EXISTS business_category_id,
    DROP COLUMN IF EXISTS business_category_name,
    DROP COLUMN IF EXISTS business_subcategory_id,
    DROP COLUMN IF EXISTS business_subcategory_name;
  `);

  await client.query(`
    ALTER TABLE crm_contacts
    DROP COLUMN IF EXISTS business_category_id,
    DROP COLUMN IF EXISTS business_category_name;
  `);
}
