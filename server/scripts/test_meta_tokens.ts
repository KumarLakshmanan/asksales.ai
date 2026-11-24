import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  // We will check the tokens for user 18 (Cruiser)
  const { db } = await import('../models/db.js');
  const { channelCredentialsTable } = await import('../models/channelCredentials/schema.js');
  const { eq } = await import('drizzle-orm');
  
  const creds = await db
    .select()
    .from(channelCredentialsTable)
    .where(eq(channelCredentialsTable.userId, 1));
    
  for (const cred of creds) {
    console.log(`\nChecking ${cred.platform} credentials (ID: ${cred.id}):`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = cred.accessToken || (cred.sessionData as any)?.pageAccessToken;
    if (!token) {
      console.log('No token found.');
      continue;
    }
    
    try {
      const meRes = await fetch(`https://graph.facebook.com/v20.0/me?access_token=${token}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meData = await meRes.json() as any;
      console.log('/me response:', meData);
      
      const permissionsRes = await fetch(`https://graph.facebook.com/v20.0/me/permissions?access_token=${token}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const permissionsData = await permissionsRes.json() as any;
      console.log('/me/permissions response:', permissionsData);
    } catch (err) {
      console.error('Fetch error:', err);
    }
  }
}

main().catch(console.error);
