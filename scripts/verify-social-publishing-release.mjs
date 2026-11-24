// Read-only production verification; run within the API container environment.
import pg from 'pg';

const email = process.argv[2];
if (!email || !email.includes('@')) throw new Error('Provide the account email to inspect.');
const pool = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 10000, max: 1 });
try {
  const { rows: users } = await pool.query('SELECT id, email, name FROM users WHERE lower(email) = lower($1)', [email]);
  if (users.length !== 1) {
    const { rows: candidates } = await pool.query("SELECT id, email, name FROM users WHERE lower(email) LIKE $1 ORDER BY id LIMIT 10", [`${email.split('@')[0]}%@${email.split('@')[1]}`]);
    console.log(JSON.stringify({ requestedAccountNotFound: email, candidates }, null, 2));
    throw new Error('The publishing QA account was not found uniquely.');
  }
  const user = users[0];
  const { rows: counts } = await pool.query('SELECT platform, status, count(*)::integer AS count FROM social_publish_attempts WHERE user_id = $1 GROUP BY platform, status ORDER BY platform, status', [user.id]);
  const { rows: overdue } = await pool.query("SELECT id, platform, status, next_attempt_at FROM social_publish_attempts WHERE user_id = $1 AND status IN ('pending','retryable_failed') AND next_attempt_at < now() - interval '2 minutes' ORDER BY id", [user.id]);
  const { rows: stale } = await pool.query("SELECT id, platform, status FROM social_publish_attempts WHERE user_id = $1 AND status = 'claimed' AND lease_expires_at < now()", [user.id]);
  const { rows: recent } = await pool.query('SELECT id, platform, status, provider_post_id IS NOT NULL AS has_provider_receipt, error_code, next_attempt_at, completed_at FROM social_publish_attempts WHERE user_id = $1 ORDER BY id DESC LIMIT 10', [user.id]);
  console.log(JSON.stringify({ account: user, databaseTimeZone: (await pool.query('SHOW timezone')).rows[0], counts, overdue, stale, recent }, null, 2));
} finally {
  await pool.end();
}
