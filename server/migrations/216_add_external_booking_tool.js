/** Make the governed external-checkout handoff available to every hotel agent. */
export async function up(client) {
  await client.query(`
    UPDATE support_agent_templates
    SET tools_enabled = COALESCE(tools_enabled, '[]'::jsonb) || '["continue_external_booking"]'::jsonb,
        version = version + 1,
        updated_at = NOW()
    WHERE agent_type = 'hotel_sales'
      AND NOT COALESCE(tools_enabled, '[]'::jsonb) @> '["continue_external_booking"]'::jsonb
  `);

  // This is a platform safety/capability tool, not a persona preference. Add it
  // to customized configurations too; the tool itself remains inert unless the
  // owner explicitly enables external booking with a valid URL.
  await client.query(`
    UPDATE ai_agent_configs
    SET tools_enabled = COALESCE(tools_enabled, '[]'::jsonb) || '["continue_external_booking"]'::jsonb,
        template_version = CASE
          WHEN template_mode = 'managed' THEN (
            SELECT version FROM support_agent_templates WHERE agent_type = 'hotel_sales'
          )
          ELSE template_version
        END,
        updated_at = NOW()
    WHERE agent_type = 'hotel_sales'
      AND NOT COALESCE(tools_enabled, '[]'::jsonb) @> '["continue_external_booking"]'::jsonb
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE support_agent_templates
    SET tools_enabled = COALESCE((
      SELECT jsonb_agg(value)
      FROM jsonb_array_elements(tools_enabled) value
      WHERE value <> '"continue_external_booking"'::jsonb
    ), '[]'::jsonb),
        updated_at = NOW()
    WHERE agent_type = 'hotel_sales'
  `);
  await client.query(`
    UPDATE ai_agent_configs
    SET tools_enabled = COALESCE((
      SELECT jsonb_agg(value)
      FROM jsonb_array_elements(tools_enabled) value
      WHERE value <> '"continue_external_booking"'::jsonb
    ), '[]'::jsonb),
        updated_at = NOW()
    WHERE agent_type = 'hotel_sales'
  `);
}
