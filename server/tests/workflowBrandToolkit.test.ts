import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

// In-memory tables answering the brand queries by their SQL shape and params.
interface Toolkit { id: number; user_id: number; business_profile_id: number; name: string; logo_url: string; primary_brand_color: string; is_default: boolean; is_active: boolean; created_at: number }
let toolkits: Toolkit[] = [];
let threads: Array<{ id: number; user_id: number; metadata: Record<string, unknown> }> = [];
let conversations: Array<{ id: number; user_id: number; brand_toolkit_id: number | null }> = [];
let messages: Array<{ id: number; user_id: number; conversation_id: number }> = [];
let campaigns: Array<{ id: number; user_id: number; brand_toolkit_id: number | null }> = [];
let tickets: Array<{ id: number; user_id: number; brand_toolkit_id: number | null }> = [];
const dialect = new PgDialect();

function answer(statement: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(statement);
  const q = text.replace(/\s+/g, ' ');
  if (q.includes('FROM brand_toolkits')) {
    let rows = [...toolkits];
    let i = 0;
    if (/WHERE id = \$\d/.test(q)) { const id = params[i++]; rows = rows.filter(r => r.id === id); }
    const userId = params[i++]; rows = rows.filter(r => r.user_id === userId && r.is_active);
    if (q.includes('business_profile_id = $')) { const bp = params[i++]; rows = rows.filter(r => r.business_profile_id === bp); }
    if (q.includes('ORDER BY is_default DESC')) rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || b.created_at - a.created_at);
    return rows.slice(0, 1);
  }
  if (q.includes('FROM chat_threads')) {
    const [id, userId] = params;
    return threads.filter(t => t.id === id && t.user_id === userId).map(t => ({ toolkit_id: t.metadata.selectedBrandToolkitId ?? null }));
  }
  if (q.includes('FROM outreach_messages m JOIN outreach_conversations')) {
    const [id, userId] = params;
    const message = messages.find(m => m.id === id && m.user_id === userId);
    const conversation = message && conversations.find(c => c.id === message.conversation_id && c.user_id === userId);
    return conversation ? [{ brand_toolkit_id: conversation.brand_toolkit_id }] : [];
  }
  if (q.includes('FROM outreach_conversations')) {
    const [id, userId] = params;
    return conversations.filter(c => c.id === id && c.user_id === userId).map(c => ({ brand_toolkit_id: c.brand_toolkit_id }));
  }
  if (q.includes('FROM support_tickets')) {
    const [id, userId] = params;
    return tickets.filter(t => t.id === id && t.user_id === userId).map(t => ({ brand_toolkit_id: t.brand_toolkit_id }));
  }
  if (q.includes('FROM outreach_campaigns')) {
    const [id, userId] = params;
    return campaigns.filter(c => c.id === id && c.user_id === userId).map(c => ({ brand_toolkit_id: c.brand_toolkit_id }));
  }
  throw new Error(`Unexpected query: ${q}`);
}

const database = {
  execute: jest.fn(async (statement: SQL) => ({ rows: answer(statement) })),
  // Email design preferences: none saved, so the classic default design is used.
  select: () => ({ from: () => ({ where: async () => [] }) }),
};
jest.unstable_mockModule('../models/db.js', () => ({ db: database }));
jest.unstable_mockModule('../models/db', () => ({ db: database }));

const { getBrandInfo } = await import('../utils/emailTemplates.js');
const { prepareDesignedEmail } = await import('../services/EmailDesignService.js');
const brand = await import('../services/outreach/WorkflowBrand.js');

const USER = 9, BUSINESS = 7;
const scoped = <T>(work: () => Promise<T>) => withBusinessScope({ userId: USER, businessProfileId: BUSINESS }, work);
const toolkit = (id: number, name: string, extra: Partial<Toolkit> = {}): Toolkit => ({
  id, user_id: USER, business_profile_id: BUSINESS, name, logo_url: `https://cdn.example.com/${name.toLowerCase()}.png`,
  primary_brand_color: '#123456', is_default: false, is_active: true, created_at: id, ...extra,
});
const setDefault = (id: number) => toolkits.forEach(t => { t.is_default = t.id === id; });

beforeEach(() => {
  toolkits = [toolkit(1, 'Aimplify', { is_default: true }), toolkit(2, 'Todle'),
    toolkit(3, 'OtherBusiness', { business_profile_id: 99 }), toolkit(4, 'OtherUser', { user_id: 55 }), toolkit(5, 'Retired', { is_active: false })];
  threads = [{ id: 40, user_id: USER, metadata: { selectedBrandToolkitId: 2 } }, { id: 41, user_id: USER, metadata: {} },
    { id: 42, user_id: 55, metadata: { selectedBrandToolkitId: 2 } }];
  conversations = []; messages = []; campaigns = []; tickets = [];
  database.execute.mockClear();
});

describe('each workflow keeps its own brand', () => {
  it('saves the brand chosen for the workflow, else the launching thread brand, else the current default', async () => {
    await scoped(async () => {
      expect(await brand.resolveWorkflowBrandToolkitId(USER, { requestedBrandToolkitId: 2 })).toBe(2);
      expect(await brand.resolveWorkflowBrandToolkitId(USER, { threadId: 40 })).toBe(2);
      expect(await brand.resolveWorkflowBrandToolkitId(USER, { threadId: 41 })).toBe(1);
      expect(await brand.resolveWorkflowBrandToolkitId(USER, {})).toBe(1);
      // An explicit choice wins over the thread's brand.
      expect(await brand.resolveWorkflowBrandToolkitId(USER, { requestedBrandToolkitId: 1, threadId: 40 })).toBe(1);
    });
  });

  it('rejects a brand from another business, another owner, or an inactive brand', async () => {
    await scoped(async () => {
      for (const id of [3, 4, 5, 'abc', -1]) {
        await expect(brand.resolveWorkflowBrandToolkitId(USER, { requestedBrandToolkitId: id })).rejects.toBeInstanceOf(brand.WorkflowBrandError);
      }
      // Another owner's thread is never read; the default is used instead.
      expect(await brand.resolveWorkflowBrandToolkitId(USER, { threadId: 42 })).toBe(1);
    });
  });

  it('keeps an ongoing outreach on its saved brand after the default changes', async () => {
    await scoped(async () => {
      conversations.push({ id: 700, user_id: USER, brand_toolkit_id: await brand.resolveWorkflowBrandToolkitId(USER, { threadId: 40 }) });
      messages.push({ id: 900, user_id: USER, conversation_id: 700 });
      setDefault(2); setDefault(1); // the business switches its default brand back and forth
      setDefault(1);
      const followUpBrand = await brand.outreachMessageBrandToolkitId(USER, 900);
      expect(followUpBrand).toBe(2);
      const html = await prepareDesignedEmail(USER, '<p>Following up</p>', 'outreach', undefined, followUpBrand);
      expect(html).toContain('todle.png');
      expect(html).not.toContain('aimplify.png');
    });
  });

  it('keeps a campaign on the brand it was created with', async () => {
    await scoped(async () => {
      campaigns.push({ id: 31, user_id: USER, brand_toolkit_id: await brand.defaultBrandToolkitId(USER) });
      setDefault(2);
      expect(await brand.campaignBrandToolkitId(USER, 31)).toBe(1);
      expect((await getBrandInfo(USER, await brand.campaignBrandToolkitId(USER, 31))).companyName).toBe('Aimplify');
    });
  });

  it('changing the default only affects items without a saved brand', async () => {
    await scoped(async () => {
      expect((await getBrandInfo(USER)).companyName).toBe('Aimplify');
      setDefault(2);
      expect((await getBrandInfo(USER)).companyName).toBe('Todle');
      expect((await getBrandInfo(USER, null)).companyName).toBe('Todle');
      expect((await getBrandInfo(USER, 1)).companyName).toBe('Aimplify');
    });
  });

  it('never renders another tenant’s brand and falls back to the default for a removed brand', async () => {
    await scoped(async () => {
      expect((await getBrandInfo(USER, 3)).companyName).toBe('Aimplify');
      expect((await getBrandInfo(USER, 4)).companyName).toBe('Aimplify');
      expect((await getBrandInfo(USER, 5)).companyName).toBe('Aimplify');
      // A legacy conversation without a saved brand uses the default.
      conversations.push({ id: 701, user_id: USER, brand_toolkit_id: null });
      expect(await brand.conversationBrandToolkitId(USER, 701)).toBeNull();
      // Another owner's conversation is not readable.
      conversations.push({ id: 702, user_id: 55, brand_toolkit_id: 4 });
      expect(await brand.conversationBrandToolkitId(USER, 702)).toBeNull();
    });
  });

  it('proposals and tickets inherit their conversation, ticket or thread brand, else today’s default', async () => {
    await scoped(async () => {
      conversations.push({ id: 710, user_id: USER, brand_toolkit_id: 2 }, { id: 711, user_id: USER, brand_toolkit_id: 5 });
      tickets.push({ id: 60, user_id: USER, brand_toolkit_id: 2 }, { id: 61, user_id: 55, brand_toolkit_id: 4 });
      const resolve = brand.resolveRecordBrandToolkitId;
      expect(await resolve(USER, { conversationId: 710, threadId: 41 })).toBe(2);
      expect(await resolve(USER, { supportTicketId: 60 })).toBe(2);
      expect(await resolve(USER, { threadId: 40 })).toBe(2);
      expect(await resolve(USER, {})).toBe(1);
      // An explicit choice wins; an inactive inherited brand is skipped, not an error.
      expect(await resolve(USER, { requestedBrandToolkitId: 1, conversationId: 710 })).toBe(1);
      expect(await resolve(USER, { conversationId: 711 })).toBe(1);
      expect(await resolve(USER, { inheritedBrandToolkitId: 2, conversationId: 711 })).toBe(2);
      expect(await resolve(USER, { inheritedBrandToolkitId: 5 })).toBe(1);
      // Another owner's ticket is never read; another business's brand is rejected.
      expect(await resolve(USER, { supportTicketId: 61 })).toBe(1);
      await expect(resolve(USER, { requestedBrandToolkitId: 3 })).rejects.toBeInstanceOf(brand.WorkflowBrandError);
    });
  });

  it('a proposal keeps its brand after the default changes', async () => {
    await scoped(async () => {
      const saved = await brand.resolveRecordBrandToolkitId(USER, {});
      setDefault(2);
      expect((await getBrandInfo(USER, saved)).companyName).toBe('Aimplify');
    });
  });

  it('creating a record outside a business scope saves no brand instead of guessing a business', async () => {
    expect(await brand.resolveRecordBrandToolkitId(USER, { threadId: 40 })).toBeNull();
  });

  it('a background job without a business scope falls back to the record’s own business default', async () => {
    // Business 99 belongs to the same owner; its only active brand is OtherBusiness.
    expect((await getBrandInfo(USER, null, 99)).companyName).toBe('OtherBusiness');
    expect((await getBrandInfo(USER, null, BUSINESS)).companyName).toBe('Aimplify');
    // Inside a business scope, the scope always wins over the passed business.
    await scoped(async () => expect((await getBrandInfo(USER, null, 99)).companyName).toBe('Aimplify'));
  });
});
