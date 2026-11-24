import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';

type Row = Record<string, unknown>;
let credentials: Row[], pages: Row[], email: Row[], web: Row[], bindings: Row[];
const dialect = new PgDialect();
const execute = jest.fn(async (query: SQL) => {
  const { sql } = dialect.sqlToQuery(query);
  if (sql.includes('FROM email_senders s')) return { rows: email };
  if (sql.includes('FROM channel_credentials WHERE')) return { rows: credentials };
  if (sql.includes('FROM meta_page_connections WHERE')) return { rows: pages };
  if (sql.includes('FROM support_teams')) return { rows: web };
  if (sql.includes('FROM outreach_assistant_bindings')) return { rows: bindings };
  return { rows: [] };
});
const list = jest.fn<() => Promise<unknown[]>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveLLMAdminCredentials: async () => [] }));
jest.unstable_mockModule('../models/intentClassifierCredentials/functions.js', () => ({ getActiveClassifierCredentials: async () => [] }));
jest.unstable_mockModule('../services/agents/orchestration/SafeToolExecutor.js', () => ({ HIGH_RISK_SUPPORT_TOOLS: new Set(), SUPPORT_TOOL_NAMES: [] }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  isPrivacyVaultConfigured: () => true,
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ resolveContentBrandContext: jest.fn() }));
jest.unstable_mockModule('../services/assistants/AssistantService.js', () => ({
  assistantService: { list }, assistantRow: jest.fn(), AssistantManagementError: class extends Error {},
}));
jest.unstable_mockModule('../services/assistants/AssistantConfiguration.js', () => ({ assistantReadiness: () => ({ ready: true, checks: [] }) }));
const { assistantAccounts } = await import('../services/assistants/AssistantCatalogService.js');
const { assistantOperations } = await import('../services/assistants/AssistantOperationsService.js');
const owner = <T>(work: () => T) => withBusinessScope({ userId: 4101, businessProfileId: 4102 }, work);

beforeEach(() => {
  execute.mockClear();
  credentials = []; pages = []; email = []; web = []; bindings = [];
  list.mockReset().mockResolvedValue([]);
});

describe('currently available assistant accounts', () => {
  it('requires a business scope before reading any account inventory', async () => {
    await expect(assistantAccounts()).rejects.toThrow('A business profile is required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('omits inactive, expired, tokenless and disabled channel credentials even if assigned', async () => {
    const active = { platform: 'whatsapp', account_identifier: 'current-line', account_name: 'Current line', is_active: true, has_secret: true };
    credentials = [active,
      { ...active, account_identifier: 'old-line', is_active: false },
      { ...active, account_identifier: 'expired-line', token_expiry: new Date(0) },
      { ...active, account_identifier: 'tokenless-line', has_secret: false },
      { ...active, account_identifier: 'disabled-line', whatsapp_enabled: 'false' },
    ];
    bindings = ['current-line', 'old-line'].map(account_id => ({ channel: 'whatsapp', surface: 'private', account_id, assistant_id: 'assistant-one' }));
    const accounts = await owner(assistantAccounts);
    expect(accounts).toEqual([{ channel: 'whatsapp', surface: 'private', accountId: 'current-line', label: 'Current line', connected: true, assignedAssistantId: 'assistant-one' }]);
    for (const [query] of execute.mock.calls) {
      const compiled = dialect.sqlToQuery(query);
      expect(compiled.sql).toContain('user_id=');
      expect(compiled.sql).toContain('business_profile_id=');
      expect(compiled.params).toEqual([4101, 4102]);
    }
  });

  it('keeps connected private/comment surfaces and omits old or disabled Meta routes', async () => {
    const current = { page_id: 'current-page', page_name: 'Current page', instagram_account_id: 'current-instagram', instagram_username: 'Current Instagram',
      is_active: true, has_secret: true, webhook_subscribed: true, facebook_active: true, instagram_active: true };
    pages = [current,
      { ...current, page_id: 'old-page', instagram_account_id: 'old-instagram', is_active: false },
      { ...current, page_id: 'expired-page', instagram_account_id: null, token_expiry: new Date(0) },
      { ...current, page_id: 'no-webhook-page', instagram_account_id: null, webhook_subscribed: false },
      { ...current, page_id: 'ads-only-page', instagram_account_id: 'disabled-instagram', facebook_active: false, instagram_active: false },
    ];
    const accounts = await owner(assistantAccounts);
    expect(accounts.map(({ accountId, surface }) => [accountId, surface])).toEqual([
      ['current-page', 'private'], ['current-page', 'public_comment'],
      ['current-instagram', 'private'], ['current-instagram', 'public_comment'],
    ]);
    expect(accounts.every(account => account.connected)).toBe(true);
  });

  it('omits disconnected email senders and web widgets', async () => {
    email = [
      { email: 'current@example.invalid', is_verified: true, route_connected: true },
      { email: 'old@example.invalid', is_verified: true, route_connected: false },
      { email: 'unverified@example.invalid', is_verified: false, route_connected: true },
    ];
    web = [{ id: 1, name: 'Current web chat', is_active: true, connected: true },
      { id: 2, name: 'Old web chat', is_active: false, connected: true },
      { id: 3, name: 'Tokenless web chat', is_active: true, connected: false }];
    expect((await owner(assistantAccounts)).map(account => account.accountId)).toEqual(['current@example.invalid', 'team:1']);
  });

  it('does not resurrect disconnected accounts from enabled assistant bindings in diagnostics', async () => {
    credentials = [{ platform: 'whatsapp', account_identifier: 'current-line', is_active: true, has_secret: true }];
    const binding = { channel: 'whatsapp', surface: 'private', accountId: 'old-line' };
    list.mockResolvedValue([{ id: 'assistant-one', draft: emptyAssistantDraft(), published: null, publishedRevision: null, enabledBindings: [binding] }]);
    const report = await owner(() => assistantOperations.diagnostics({}));
    expect(report.assignments.map(account => account.accountId)).toEqual(['current-line']);
    credentials = [];
    expect((await owner(() => assistantOperations.diagnostics({}))).assignments).toEqual([]);
  });
});
