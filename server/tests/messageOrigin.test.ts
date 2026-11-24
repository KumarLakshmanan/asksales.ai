import { describe, expect, it, jest } from '@jest/globals';

const execute = jest.fn(async (_query: unknown) => ({ rows: [] as Array<Record<string, unknown>> }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { describeMessageOrigin, withMessageOrigins } = await import('../services/outreach/MessageOrigin.js');

const base = { id: 1, direction: 'outbound' };

describe('describeMessageOrigin', () => {
  it('ignores customer messages', () => {
    expect(describeMessageOrigin({ ...base, direction: 'inbound' }, 'whatsapp')).toBeNull();
  });

  it('labels an outreach launch with its name, template and follow-up step', () => {
    expect(describeMessageOrigin(
      { ...base, batchId: 'b1', templateName: 'diwali_offer', messageKind: 'follow_up', followUpStep: 2 },
      'whatsapp', { outreachName: 'Diwali launch' },
    )).toEqual({ kind: 'outreach', label: 'AskSales outreach', outreachName: 'Diwali launch', templateName: 'diwali_offer', followUpStep: 2 });
  });

  it('labels phone and web app sends', () => {
    expect(describeMessageOrigin({ ...base, metadata: { origin: 'native_app' } }, 'whatsapp'))
      .toEqual({ kind: 'native_app', label: 'Sent from the WhatsApp Business app (phone or web)' });
  });

  it('labels AI replies before outreach provenance', () => {
    expect(describeMessageOrigin({ ...base, isAiGenerated: true, batchId: 'b1' }, 'instagram')?.kind).toBe('ai');
  });

  it('labels inbox sends as manual, with the template when one was used', () => {
    expect(describeMessageOrigin({ ...base, metadata: { origin: 'inbox' }, templateName: 'restart' }, 'whatsapp'))
      .toEqual({ kind: 'manual', label: 'Sent manually in AskSales', templateName: 'restart' });
  });

  it('does not claim unstamped AskSales sends were manual', () => {
    expect(describeMessageOrigin({ ...base }, 'whatsapp')).toEqual({ kind: 'manual', label: 'Sent from AskSales', templateName: null });
  });

  it('labels CRM automations', () => {
    expect(describeMessageOrigin({ ...base, metadata: { origin: 'crm_automation' } }, 'sms')?.label).toBe('CRM automation');
  });
});

describe('withMessageOrigins', () => {
  it('looks up outreach names in one query per kind and skips queries with nothing to look up', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'b1', name: 'Diwali launch' }] });
    const [inbound, outbound] = await withMessageOrigins(7, 'whatsapp', [
      { id: 1, direction: 'inbound' },
      { id: 2, direction: 'outbound', batchId: 'b1' },
    ]);
    expect(inbound.origin).toBeNull();
    expect(outbound.origin).toMatchObject({ kind: 'outreach', outreachName: 'Diwali launch' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
