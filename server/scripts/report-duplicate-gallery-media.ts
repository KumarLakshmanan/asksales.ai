/**
 * READ-ONLY report of duplicate Image/Video gallery rows: several content_assets
 * of the same user and type pointing at the same stored file. It changes no data.
 *
 *   npx tsx scripts/report-duplicate-gallery-media.ts [--user-id=<id>] [--json]
 *
 * Review the output before any cleanup. A cleanup should keep the oldest id of
 * each group, back up the others (SELECT * ... to a file) and delete them with
 * ContentAssetModel.deleteForUser so storage references are released correctly;
 * the kept row still references the file, so no media is lost. Never run a
 * cleanup against production without explicit approval.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withSystemScope } from '../tenancy/businessContext.js';

const ownerArg = process.argv.find(arg => arg.startsWith('--user-id='));
const userId = ownerArg ? Number(ownerArg.split('=')[1]) : null;
if (ownerArg && (!Number.isSafeInteger(userId) || Number(userId) <= 0)) throw new Error('Expected --user-id=<positive integer>.');
const asJson = process.argv.includes('--json');

async function main() {
  const result = await withSystemScope('Report duplicate gallery media (read-only)', () => db.execute(sql`
    WITH media AS (
      SELECT id, user_id, type, created_at,
        split_part(split_part(COALESCE(NULLIF(image_url, ''), NULLIF(video_url, ''),
          CASE WHEN content LIKE '/uploads/%' OR content LIKE 'https://%' THEN content END, ''), '?', 1), '#', 1) AS url
      FROM content_assets
      WHERE type IN ('image', 'video') AND (${userId}::integer IS NULL OR user_id = ${userId})
    )
    SELECT user_id, type, url, COUNT(*)::int AS copies,
      MIN(id) AS keep_id, ARRAY_AGG(id ORDER BY id) AS ids, MIN(created_at) AS first_created
    FROM media
    WHERE url <> ''
    GROUP BY user_id, type, url
    HAVING COUNT(*) > 1
    ORDER BY copies DESC, user_id
    LIMIT 500`));
  const groups = result.rows as Array<{ user_id: number; type: string; url: string; copies: number; keep_id: number; ids: number[] }>;
  if (asJson) {
    console.log(JSON.stringify(groups, null, 2));
  } else {
    console.log(`Duplicate gallery groups: ${groups.length}; extra rows: ${groups.reduce((sum, group) => sum + group.copies - 1, 0)}`);
    for (const group of groups) {
      console.log(`user ${group.user_id} · ${group.type} · ${group.copies} copies · keep #${group.keep_id} · ids ${group.ids.join(',')} · ${group.url}`);
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
