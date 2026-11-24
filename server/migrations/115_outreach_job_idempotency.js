/** Prevent retries or concurrent schedulers from enqueuing the same step twice. */
export async function up(client) {
  await client.query(`
    DELETE FROM outreach_jobs duplicate
    USING outreach_jobs keeper
    WHERE duplicate.id > keeper.id
      AND duplicate.campaign_id IS NOT NULL
      AND duplicate.campaign_id = keeper.campaign_id
      AND duplicate.lead_id = keeper.lead_id
      AND duplicate.sequence_step_id = keeper.sequence_step_id
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_jobs_campaign_lead_step_unique
    ON outreach_jobs(campaign_id, lead_id, sequence_step_id)
    WHERE campaign_id IS NOT NULL
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS outreach_jobs_campaign_lead_step_unique');
}
