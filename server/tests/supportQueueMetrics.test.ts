import { describe, expect, it } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { currentSupportQueueQuery } from '../services/SupportQueueMetrics.js';
describe('current support queue query', () => {
  it('counts the owner’s unresolved workload across creation dates, excluding deleted and completed tickets', () => {
    const query = new PgDialect().sqlToQuery(currentSupportQueueQuery(9));
    expect(query.params).toEqual([9]);
    expect(query.sql).toContain('user_id=$1');
    expect(query.sql).toContain('deleted_at IS NULL');
    expect(query.sql).toContain("status IN ('open','in_progress','waiting_on_customer')");
    expect(query.sql).not.toContain('created_at');
    expect(query.sql).toContain('sla_deadline < NOW()');
  });
});
