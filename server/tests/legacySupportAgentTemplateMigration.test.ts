import { describe, expect, it, jest } from '@jest/globals';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up } from '../migrations/165_repair_legacy_support_agent_templates.js';

describe('legacy support agent template repair migration', () => {
  it('uses a narrow legacy predicate, preserves owner fields, and audits repairs', async () => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [] };
    }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await up(client as any);
    const sql = statements.join('\n');
    expect(sql).toContain("config.template_mode = 'custom'");
    expect(sql).toContain('config.template_version IS NULL');
    expect(sql).toContain("COALESCE(config.tools_enabled, '[]'::jsonb) = '[]'::jsonb");
    expect(sql).toContain("mandatoryControlProfileVersion");
    expect(sql).toContain("template_mode = 'customized'");
    expect(sql).not.toContain('system_prompt =');
    expect(sql).not.toContain('metadata = candidates');
    expect(sql).toContain('support_admin_audit_logs');
  });
});
