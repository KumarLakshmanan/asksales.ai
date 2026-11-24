/**
 * Chat history survives business-profile deletion; only the optional profile
 * association is cleared, matching the other business-profile references.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE chat_threads
      DROP CONSTRAINT IF EXISTS chat_threads_business_id_company_settings_id_fk;
    ALTER TABLE chat_threads
      ADD CONSTRAINT chat_threads_business_id_company_settings_id_fk
      FOREIGN KEY (business_id) REFERENCES company_settings(id)
      ON DELETE SET NULL;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE chat_threads
      DROP CONSTRAINT IF EXISTS chat_threads_business_id_company_settings_id_fk;
    ALTER TABLE chat_threads
      ADD CONSTRAINT chat_threads_business_id_company_settings_id_fk
      FOREIGN KEY (business_id) REFERENCES company_settings(id)
      ON DELETE NO ACTION;
  `);
}
