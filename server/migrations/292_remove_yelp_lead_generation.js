/** Remove Yelp selections and defaults without deleting historical lead receipts. */
export async function up(client) {
  await client.query(`
    ALTER TABLE lead_settings ALTER COLUMN lead_sources
      SET DEFAULT ARRAY['linkedin','google','justdial','instagram','facebook','twitter']::text[];
    UPDATE lead_settings SET lead_sources = ARRAY(
      SELECT source FROM unnest(lead_sources) source WHERE lower(trim(source)) IS DISTINCT FROM 'yelp'
    ), updated_at = NOW() WHERE EXISTS (
      SELECT 1 FROM unnest(lead_sources) source WHERE lower(trim(source)) = 'yelp'
    );
    UPDATE icp_profiles SET primary_channels = (
      SELECT COALESCE(jsonb_agg(channel), '[]'::jsonb)
      FROM jsonb_array_elements(primary_channels) channel
      WHERE lower(trim(channel #>> '{}')) IS DISTINCT FROM 'yelp'
    ), updated_at = NOW()
    WHERE jsonb_typeof(primary_channels) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(primary_channels) = 'array' THEN primary_channels ELSE '[]'::jsonb END) channel
        WHERE lower(trim(channel #>> '{}')) = 'yelp');
  `);
}

export async function down(client) {
  // Restore the previous default only; never invent a user's old selections.
  await client.query(`ALTER TABLE lead_settings ALTER COLUMN lead_sources
    SET DEFAULT ARRAY['linkedin','google','justdial','yelp','instagram','facebook','twitter']::text[]`);
}
