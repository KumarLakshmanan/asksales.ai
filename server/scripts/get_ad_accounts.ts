import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  console.log('--- Fetching Meta Ad Accounts ---');
  
  const { db } = await import('../models/db.js');
  const { metaPageConnectionsTable } = await import('../models/metaPageConnections/schema.js');
  const { eq } = await import('drizzle-orm');

  // Fetch the connection for User 1
  const conns = await db
    .select()
    .from(metaPageConnectionsTable)
    .where(eq(metaPageConnectionsTable.userId, 1));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = conns.find((c: any) => c.pageId === '971735822683328');
  if (!conn || !conn.userAccessToken) {
    console.error('No meta page connection or user access token found for Aimplify Tech.');
    process.exit(1);
  }

  const token = conn.userAccessToken;
  const version = 'v25.0';
  const url = `https://graph.facebook.com/${version}/me/adaccounts?fields=id,name,currency,timezone_name,account_status&access_token=${token}`;

  console.log('Querying Graph API...');
  const res = await fetch(url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();

  if (!res.ok) {
    console.error('Error fetching ad accounts:', data);
    process.exit(1);
  }

  console.log('Ad Accounts response:', JSON.stringify(data.data, null, 2));
}

main().catch(console.error);
