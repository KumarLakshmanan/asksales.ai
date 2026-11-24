import { getActiveAdminCredential } from '../models/adminApiCredentials/functions';

/** The admin-configured Meta app id and secret, or null when either is missing. */
export async function getAdminMetaCredentials(): Promise<{ appId: string; appSecret: string } | null> {
  const credential = await getActiveAdminCredential('meta_app');
  if (credential?.apiKey && credential?.apiSecret) {
    return { appId: credential.apiKey, appSecret: credential.apiSecret };
  }
  return null;
}

