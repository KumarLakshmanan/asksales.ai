import { describe, expect, it } from '@jest/globals';
import { redactPiiWithStableTokens, encryptRestrictedPayload, decryptRestrictedPayload } from '../services/agents/orchestration/PrivacyVaultService.js';
import { formatMessageForChannel } from '../utils/messageFormatter.js';
import { sanitizeSupportToolResult } from '../services/agents/orchestration/SafeToolExecutor.js';
import { DEFAULT_SUPPORT_PLAYBOOKS } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { collectJourneyFields, initializeJourneyState } from '../services/agents/orchestration/SupportJourneyRuntime.js';
import { validatePlaybookGraph } from '../services/agents/orchestration/PlaybookEngine.js';

describe('support audit runtime regressions', () => {
  it('redacts labeled forms and uses distinct stable identities per conversation', () => {
    const scope = { userId: 8, conversationId: 90 };
    const redacted = redactPiiWithStableTokens('Full name: Keerthan P B\nAddress: 15 Lake Road\nPAN: ABCDE1234F\nEmail: a@example.com and a@example.com', scope);
    expect(redacted.piiTypes).toEqual(expect.arrayContaining(['name', 'address', 'government_id', 'email']));
    expect(redacted.redactedText).not.toContain('Keerthan');
    expect(redactPiiWithStableTokens(redacted.redactedText, scope).redactedText).toBe(redacted.redactedText);
    const tokens = redacted.redactedText.match(/\[EMAIL_\d+\]/g)!;
    expect(tokens[0]).toBe(tokens[1]);
    expect(redactPiiWithStableTokens('a@example.com', scope).redactedText).toBe(tokens[0]);
    expect(redactPiiWithStableTokens('b@example.com', scope).redactedText).not.toBe(tokens[0]);
    expect(redactPiiWithStableTokens('a@example.com', { ...scope, conversationId: 91 }).redactedText).not.toBe(tokens[0]);
  });
  it('preserves verified property contacts while protecting customer tool fields', () => {
    const raw = { toolResults: [{ name: 'get_hotel_info', result: { success: true, name: 'Oro', email: 'stay@oro.test', phone: '+91 9876543210', address: '15 Lake Road' } }] };
    expect(sanitizeSupportToolResult('get_hotel_info', raw).toolResults![0].result).toEqual(raw.toolResults[0].result);
    expect(sanitizeSupportToolResult('get_ticket_status', { toolResults: [{ name: 'get_ticket_status', result: { success: true, customerEmail: 'guest@example.com' } }] }).toolResults![0].result.customerEmail).toBe('[REDACTED_PII]');
  });
  it('redacts Indian mobile numbers with five-plus-five grouping', () => {
    for (const phone of ['+91 98765 43210', '+91 91234 56789', '98765 43210']) {
      expect(redactPiiWithStableTokens(phone).redactedText).toBe('[PHONE_1]');
    }
  });
  it('removes executable email HTML and unsafe links while keeping safe formatting', () => {
    const html = formatMessageForChannel('<p onclick="steal()">Hello <strong>guest</strong><script>steal()</script><a href="javascript:steal()">bad</a><a href="https://example.com">safe</a><img src=x onerror=steal()></p>', 'email');
    expect(html).toContain('<strong>guest</strong>');
    expect(html).toContain('https://example.com');
    expect(html).not.toMatch(/script|onclick|onerror|javascript|<img/i);
    expect(formatMessageForChannel('**Hello** & welcome < 5', 'email')).toContain('&amp; welcome &lt; 5');
  });
  it('ships executable read capabilities and rejects inverted stay dates before a tool runs', () => {
    for (const key of ['hotel-availability-booking-v1', 'technical-ticket-status-v1']) {
      const graph = DEFAULT_SUPPORT_PLAYBOOKS.find(item => item.key === key)!.graph;
      expect(validatePlaybookGraph(graph)).toEqual([]);
      expect(graph.nodes.some(node => node.type === 'capability')).toBe(true);
    }
    const graph = DEFAULT_SUPPORT_PLAYBOOKS[0].graph;
    const state = collectJourneyFields(graph, graph.nodes.find(node => node.type === 'collect')!, initializeJourneyState(graph), {
      inboundText: 'Check in 2030-10-12 and check out 2030-10-10, 2 guests, 1 room',
      entities: { checkIn: '2030-10-12', checkOut: '2030-10-10', guests: 2, rooms: 1 },
    });
    expect(state.fields['stay.checkOut'].status).toBe('invalid');
  });
  it('uses the stored key version when decrypting retained data', () => {
    const old = process.env.SUPPORT_PII_ENCRYPTION_KEY;
    process.env.SUPPORT_PII_ENCRYPTION_KEY = 'test-key-with-at-least-32-characters';
    try {
      const payload = encryptRestrictedPayload(9, 'test', { value: 'private' });
      expect(decryptRestrictedPayload(9, 'test', payload)).toEqual({ value: 'private' });
      expect(() => decryptRestrictedPayload(10, 'test', payload)).toThrow();
      expect(() => decryptRestrictedPayload(9, 'test', { ...payload, keyVersion: 99 })).toThrow();
    } finally { if (old === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY; else process.env.SUPPORT_PII_ENCRYPTION_KEY = old; }
  });
});
