import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const getTicketById = jest.fn<(...args: any[]) => Promise<any>>();
const executeQuery = jest.fn<(...args: any[]) => Promise<any[]>>();
jest.unstable_mockModule('../services/SupportService.js', () => ({ supportService: { getTicketById } }));
jest.unstable_mockModule('../services/agents/SalesIntelligence.js', () => ({ salesIntelligence: {} }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => ({ from: () => ({ where: (query: unknown) => ({
  orderBy: () => ({ limit: () => executeQuery(query) }),
}) }) }) } }));
const { TicketSubAgent } = await import('../services/agents/subagents/TicketSubAgent.js');
const agent = new TicketSubAgent();
const context: any = { userId: 9, conversationId: 20, lead: { id: 30 } };
beforeEach(() => { jest.clearAllMocks(); });
describe('customer ticket lookup ownership', () => {
  it('rejects a same-tenant ticket belonging to another customer', async () => {
    getTicketById.mockResolvedValue({ id: 88, leadId: 31, outreachConversationId: 21, subject: 'Private other customer' });
    const result = await agent.execute('get_ticket_status', { ticket_id: 88 }, context);
    expect(result.toolResults?.[0].result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Private other customer');
  });
  it('allows a verified current lead or current conversation only', async () => {
    for (const binding of [{ leadId: 30 }, { outreachConversationId: 20 }]) {
      getTicketById.mockResolvedValue({ id: 88, status: 'open', ...binding });
      expect((await agent.execute('get_ticket_status', { ticket_id: 88 }, context)).toolResults?.[0].result.success).toBe(true);
    }
  });
  it('does not list tenant tickets when verified identity is missing', async () => {
    expect((await agent.execute('get_ticket_status', {}, { ...context, conversationId: -1, lead: {} })).toolResults?.[0].result.success).toBe(false);
    expect(executeQuery).not.toHaveBeenCalled(); expect(getTicketById).not.toHaveBeenCalled();
  });
});
