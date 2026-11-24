import { describe, expect, it, jest } from '@jest/globals';
import { OAuth2Client } from 'google-auth-library';
import { configureGmailConnectionTransport, configureGmailPersistedTokenClient } from '../utils/gmailOAuthDiagnostics.js';

describe('installed Google SDK connection transport', () => {
  it.each([240_000, 180_000, 61_000])('uses a valid persisted token %i ms before expiry without an SDK refresh', async remainingMs => {
    const fetchImplementation = jest.fn<typeof fetch>();
    const client = new OAuth2Client({ clientId: 'fixture-client', clientSecret: 'fixture-secret', transporterOptions: { fetchImplementation } });
    client.setCredentials({ access_token: 'fixture-access', expiry_date: Date.now() + remainingMs });
    await expect(client.getRequestHeaders()).rejects.toThrow('No refresh token is set.');
    configureGmailPersistedTokenClient(client);
    expect((await client.getRequestHeaders()).get('authorization')).toBe('Bearer fixture-access');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
  it('does not authorize an expired token or try an unpersisted refresh', async () => {
    const fetchImplementation = jest.fn<typeof fetch>();
    const client = new OAuth2Client({ transporterOptions: { fetchImplementation } });
    configureGmailPersistedTokenClient(client);
    client.setCredentials({ access_token: 'fixture-access', expiry_date: Date.now() - 1000 });
    await expect(client.getRequestHeaders()).rejects.toThrow('No refresh token is set.');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
  it('never replays a Gmail message POST after an authentication rejection', async () => {
    const fetchImplementation = jest.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ error: { code: 401, message: 'Synthetic authentication rejection' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    const client = new OAuth2Client({ transporterOptions: { fetchImplementation } });
    configureGmailConnectionTransport(client);
    configureGmailPersistedTokenClient(client);
    client.setCredentials({ access_token: 'fixture-access', expiry_date: Date.now() + 180_000 });
    await expect(client.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST', data: { raw: 'fixture' } }))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
  it('does not replay a single-use authorization code when Google returns a server error', async () => {
    const fetchImplementation = jest.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ error: 'temporarily_unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ));
    const client = new OAuth2Client({
      clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'https://app.example.test/api/gmail/oauth/callback',
      transporterOptions: { fetchImplementation },
    });
    configureGmailConnectionTransport(client);
    await expect(client.getToken('fixture-single-use-code')).rejects.toMatchObject({ response: { status: 503 } });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
