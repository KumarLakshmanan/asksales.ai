import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const { db } = await import('../models/db.js');
  const { channelCredentialsTable } = await import('../models/channelCredentials/schema.js');
  const { eq } = await import('drizzle-orm');
  
  // Get user 18's instagram_api credential (which has the valid user token for the new app)
  const [instCred] = await db
    .select()
    .from(channelCredentialsTable)
    .where(eq(channelCredentialsTable.id, 15)); // ID 15 was the instagram_api token we debugged
    
  if (!instCred || !instCred.accessToken) {
    console.error('Credential ID 15 not found or has no access token');
    return;
  }
  
  const userToken = instCred.accessToken;
  console.log('Using User Token:', userToken.substring(0, 15) + '...');
  
  // Get user's managed Facebook Pages and their Page Access Tokens
  try {
    const url = `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,tasks&access_token=${userToken}`;
    const res = await fetch(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    
    if (data.error) {
      console.error('Error fetching pages:', data.error);
      return;
    }
    
    console.log('\n--- Managed Pages ---');
    console.log(JSON.stringify(data.data, null, 2));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

main().catch(console.error);
