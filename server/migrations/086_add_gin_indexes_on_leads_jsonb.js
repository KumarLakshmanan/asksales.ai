/**
 * Migration: add_gin_indexes_on_leads_jsonb
 * Phase 3.4: Backfill GIN indexes on JSONB columns that the schema declares,
 * so production tables get the speedup even on data inserted before the
 * schema was updated.
 */
export async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_location_gin
      ON leads USING gin (location);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_previous_roles_gin
      ON leads USING gin (previous_roles);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_skills_gin
      ON leads USING gin (skills);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_tags_gin
      ON leads USING gin (tags);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_campaign_data_gin
      ON leads USING gin (campaign_data);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_platform_extended_gin
      ON leads USING gin (platform_extended);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_raw_data_gin
      ON leads USING gin (raw_data);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_enriched_data_gin
      ON leads USING gin (enriched_data);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_intent_topics_gin
      ON leads USING gin (intent_topics);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS leads_search_keywords_gin
      ON leads USING gin (search_keywords);
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS leads_location_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_previous_roles_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_skills_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_tags_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_campaign_data_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_platform_extended_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_raw_data_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_enriched_data_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_intent_topics_gin;`);
  await client.query(`DROP INDEX IF EXISTS leads_search_keywords_gin;`);
}
