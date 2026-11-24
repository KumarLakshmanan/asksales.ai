import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { normalizeMSG91Phone, validateMSG91Settings } from '../../shared/msg91.js';
import { verifyMSG91Configuration, getMSG91Balance } from '../services/integrations/MSG91ProviderService.js';

const settings = { senderId: 'ABCDEF', flowId: 'template-42', messageVariable: 'message' };
const activeTemplate = { template_id: 'template-42', sender_id: 'ABCDEF', status: '1', active_status: '1', reject_reason: '', template_data: 'Update: ##message##', template_name: 'Customer update' };
const reply = (versions: unknown[] = [activeTemplate]) => Response.json({ status: 'success', hasError: false, errors: [], data: versions });

describe('MSG91 template verification', () => {
  beforeEach(() => { jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply()); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('inspects the template without sending an SMS', async () => {
    expect(await verifyMSG91Configuration('qa-auth-key', settings)).toMatchObject({ success: true, templateName: 'Customer update' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://control.msg91.com/api/v5/sms/getTemplateVersions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ template_id: 'template-42' }), redirect: 'error',
      headers: { authkey: 'qa-auth-key', accept: 'application/json', 'Content-Type': 'application/json' },
    }));
  });

  it.each([
    [{ sender_id: 'OTHERX' }, 'MSG91_SENDER_MISMATCH'],
    [{ active_status: '0' }, 'MSG91_TEMPLATE_UNAVAILABLE'],
    [{ reject_reason: 'Rejected' }, 'MSG91_TEMPLATE_UNAVAILABLE'],
    [{ template_id: 'another-template' }, 'MSG91_TEMPLATE_UNAVAILABLE'],
    [{ template_data: '##Message##' }, 'MSG91_TEMPLATE_VARIABLES'],
    [{ template_data: '##message## ##name##' }, 'MSG91_TEMPLATE_VARIABLES'],
    [{ template_data: 'No variables' }, 'MSG91_TEMPLATE_VARIABLES'],
  ])('rejects a mismatched or unusable active version: %j', async (changes, code) => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(reply([{ ...activeTemplate, ...changes }]));
    expect(await verifyMSG91Configuration('qa-auth-key', settings)).toMatchObject({ success: false, code });
  });

  it('selects the active accepted version instead of a rejected historical version', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(reply([{ ...activeTemplate, active_status: '0', reject_reason: 'Old version' }, activeTemplate]));
    expect(await verifyMSG91Configuration('qa-auth-key', settings)).toMatchObject({ success: true });
  });

  it('does not accept error JSON with HTTP 200 as verification', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ status: 'error', hasError: true, errors: 'Template content type could not be fetched', data: [] }));
    expect(await verifyMSG91Configuration('qa-auth-key', settings)).toMatchObject({ success: false, code: 'MSG91_TEMPLATE_UNAVAILABLE' });
  });

  it('recognizes unauthorized responses even when the response is not JSON', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('Unauthorized qa-auth-key', { status: 401 }));
    const result = await verifyMSG91Configuration('qa-auth-key', settings);
    expect(result).toMatchObject({ success: false, code: 'MSG91_AUTH_FAILED' });
    expect(JSON.stringify(result)).not.toContain('qa-auth-key');
  });

  it('handles timeouts without exposing request details', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('qa-auth-key timeout'));
    const result = await verifyMSG91Configuration('qa-auth-key', settings);
    expect(result).toMatchObject({ success: false, code: 'MSG91_PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('qa-auth-key');
  });

  it('accepts zero balance from the documented route balance endpoint', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('0'));
    expect(await getMSG91Balance('qa-auth-key')).toEqual({ success: true, balance: 0 });
    const url = new URL(String(jest.mocked(globalThis.fetch).mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.msg91.com/api/balance.php');
    expect(url.searchParams.get('type')).toBe('4');
    expect(url.searchParams.get('authkey')).toBe('qa-auth-key');
  });

  it('rejects textual balance errors rather than inventing a zero balance', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('Invalid authkey qa-auth-key'));
    const result = await getMSG91Balance('qa-auth-key');
    expect(result.success).toBe(false);
    expect(result.balance).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('qa-auth-key');
  });
});

describe('shared SMS configuration and recipient validation', () => {
  it.each(['mobiles', 'crqid', 'uuid', 'clientid', 'constructor', 'inmsid'])('reserves provider routing variable %s', variable => {
    expect(validateMSG91Settings({ ...settings, messageVariable: variable })).not.toBeNull();
  });
  it('keeps legacy Flow IDs compatible with the MSG91 Template ID setting', () => {
    expect(validateMSG91Settings(settings)).toBeNull();
    expect(normalizeMSG91Phone('9198765432')).toBe('919198765432');
    expect(normalizeMSG91Phone('+91 98765 43210')).toBe('919876543210');
    expect(normalizeMSG91Phone('0044 7700 900123')).toBe('447700900123');
    expect(normalizeMSG91Phone('987654321')).toBeNull();
  });
});
