import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

export async function verifyGoogleCredential(credential: string, clientId: string): Promise<GoogleIdentity> {
  const ticket = await new OAuth2Client(clientId).verifyIdToken({
    idToken: credential,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  const email = payload?.email?.trim().toLowerCase();
  const name = payload?.name?.trim() || payload?.given_name?.trim();

  if (!payload?.sub || !email || !payload.email_verified || !name || name.length > 255) {
    throw new Error('Google did not provide a verified email address and name.');
  }

  return { sub: payload.sub, email, name };
}
