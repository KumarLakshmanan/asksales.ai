/**
 * Migration: create_chat_summaries
 * Creates the chat_summaries table for storing conversation compaction summaries.
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_summaries (
      id              SERIAL PRIMARY KEY,
      thread_id       INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      summary_text    TEXT NOT NULL,
      key_entities    JSONB DEFAULT '[]',
      timeline        JSONB DEFAULT '[]',
      from_message_id INTEGER,
      to_message_id   INTEGER,
      message_count   INTEGER DEFAULT 0,
      token_counts    JSONB DEFAULT '{}',
      version         INTEGER DEFAULT 1,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_summaries_thread_id_idx
      ON chat_summaries (thread_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_summaries_user_id_idx
      ON chat_summaries (user_id)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS chat_summaries`);
}
