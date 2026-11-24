/**
 * Migration 089 — GIN index on outreach_conversations.metadata
 * Enables fast `metadata @> '{...}'` and `metadata ?| 'k1,k2'` lookups
 * used by the conversation filter UI.
 */
export const up = async (db) => {
  await db.query(`
    CREATE INDEX IF NOT EXISTS outreach_conversations_metadata_gin
      ON outreach_conversations USING GIN (metadata);
  `);
};

export const down = async (db) => {
  await db.query(`DROP INDEX IF EXISTS outreach_conversations_metadata_gin;`);
};
