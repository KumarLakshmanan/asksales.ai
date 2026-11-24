import { describe, expect, it } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { leadUploadLookup } from '../services/outreach/leadUploadLookup.js';

describe('lead upload duplicate lookup', () => {
  const dialect = new PgDialect();
  it.each([
    [['qa@example.test'], []],
    [[], ['+15550001001']],
    [['qa@example.test', 'other@example.test'], ['+15550001001']],
  ])('uses valid parameters for emails %p and phones %p', (emails, phones) => {
    const query = dialect.sqlToQuery(leadUploadLookup(7, 42, emails, phones));
    expect(query.sql).not.toMatch(/IN\s*\(\s*\)|ANY\s*\(\s*\(\s*\)/i);
    expect(query.params).toEqual([7, 42, ...emails, ...phones]);
    expect(query.sql).toContain('l.business_profile_id');
    expect(query.sql).toContain('l.user_id');
  });
});
