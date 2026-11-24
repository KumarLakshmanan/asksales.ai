/**
 * Migration: create_workflow_mapping_tables
 * Creates connection_mappings, field_mappings, array_iteration_configs, db_save_mappings tables
 */

export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS connection_mappings (
    id SERIAL PRIMARY KEY,
    workflow_id INTEGER NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    mappings JSONB NOT NULL,
    array_iteration_config JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await client.query(`CREATE TABLE IF NOT EXISTS field_mappings (
    id SERIAL PRIMARY KEY,
    connection_mapping_id INTEGER NOT NULL,
    source_field_path TEXT NOT NULL,
    target_field_path TEXT NOT NULL,
    transformation_type VARCHAR(50) DEFAULT 'direct',
    transformation_logic TEXT,
    error_strategy VARCHAR(20) DEFAULT 'skip',
    default_value JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await client.query(`CREATE TABLE IF NOT EXISTS array_iteration_configs (
    id SERIAL PRIMARY KEY,
    connection_mapping_id INTEGER NOT NULL,
    source_array_path TEXT NOT NULL,
    iteration_mode VARCHAR(50) DEFAULT 'sequential',
    batch_size INTEGER,
    item_reference_variable TEXT DEFAULT '_current_item',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await client.query(`CREATE TABLE IF NOT EXISTS db_save_mappings (
    id SERIAL PRIMARY KEY,
    workflow_id INTEGER NOT NULL,
    db_save_node_id TEXT NOT NULL,
    database_table TEXT NOT NULL,
    field_mappings JSONB NOT NULL,
    batch_insert BOOLEAN DEFAULT false,
    on_conflict VARCHAR(50) DEFAULT 'skip',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS db_save_mappings`);
  await client.query(`DROP TABLE IF EXISTS array_iteration_configs`);
  await client.query(`DROP TABLE IF EXISTS field_mappings`);
  await client.query(`DROP TABLE IF EXISTS connection_mappings`);
}
