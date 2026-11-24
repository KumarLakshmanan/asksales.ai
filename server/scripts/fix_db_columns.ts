import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  console.log('Adding missing columns to DB...');
  const { db } = await import('../models/db.js');
  const { sql } = await import('drizzle-orm');
  
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_setup_complete BOOLEAN DEFAULT FALSE;
  `);
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
