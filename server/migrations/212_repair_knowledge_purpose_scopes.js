/**
 * Repair the initial knowledge-v2 cutover, which created legacy documents with
 * only `support_answer`. The runtime already assigns the broader governed
 * scopes to newly ingested non-Q&A sources; this migration makes existing
 * documents consistent and prevents invalid future scope arrays.
 */
export async function up(client) {
  await client.query(`
    UPDATE knowledge_documents
    SET usage_scopes = CASE
          WHEN source_type = 'qa' THEN
            ARRAY['support_answer', 'outreach_reply', 'internal_assist']::text[]
          ELSE
            ARRAY[
              'support_answer', 'outreach_reply', 'content_draft',
              'proposal', 'hotel_policy', 'internal_assist'
            ]::text[]
        END,
        updated_at = NOW()
    WHERE usage_scopes IS DISTINCT FROM CASE
      WHEN source_type = 'qa' THEN
        ARRAY['support_answer', 'outreach_reply', 'internal_assist']::text[]
      ELSE
        ARRAY[
          'support_answer', 'outreach_reply', 'content_draft',
          'proposal', 'hotel_policy', 'internal_assist'
        ]::text[]
    END
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'knowledge_documents_usage_scopes_check'
      ) THEN
        ALTER TABLE knowledge_documents
          ADD CONSTRAINT knowledge_documents_usage_scopes_check
          CHECK (
            cardinality(usage_scopes) > 0
            AND usage_scopes <@ ARRAY[
              'support_answer', 'outreach_reply', 'content_draft',
              'proposal', 'hotel_policy', 'internal_assist'
            ]::text[]
          );
      END IF;
    END $$
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE knowledge_documents
      DROP CONSTRAINT IF EXISTS knowledge_documents_usage_scopes_check
  `);
  // Scope repair is intentionally retained on rollback: narrowing published
  // documents again would recreate the production retrieval outage.
}
