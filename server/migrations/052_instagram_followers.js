export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS instagram_followers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      follower_username VARCHAR(255) NOT NULL,
      follower_id VARCHAR(255),
      full_name VARCHAR(255),
      profile_pic_url TEXT,
      followed_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, follower_username)
    )
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS instagram_followers`);
}
