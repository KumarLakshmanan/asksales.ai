import { describe, expect, it } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mergeSupportPipelineDetails, supportPipelineDetailsQuery } from '../services/SupportPipelineReadModel.js';

describe('support pipeline read model', () => {
  it('bounds enrichment to authorized ticket IDs without loading ticket-workspace audit history', () => {
    const query = new PgDialect().sqlToQuery(supportPipelineDetailsQuery(9, [12, 24], { kind: 'owner', id: 17 }));
    expect(query.params).toEqual(['owner', 17, 9, 12, 24]);
    expect(query.sql).toContain('ticket.user_id=$3');
    expect(query.sql).toContain('ticket.deleted_at IS NULL');
    expect(query.sql).toContain('ticket.id IN ($4, $5)');
    expect(query.sql).toContain('receipt.reader_kind=$1 AND receipt.reader_id=$2');
    expect(query.sql).not.toContain('agent_audit_logs');
    expect(query.sql).not.toContain('support_delivery_outbox');
  });

  it('keeps ticket ordering, assignments and each reader’s unread counts when detail rows arrive out of order', () => {
    const tickets = [{ id: 12, subject: 'First', assignedMemberId: 5 }, { id: 24, subject: 'Second' }, { id: 36, subject: 'Third' }];
    const result = mergeSupportPipelineDetails(tickets, [
      { id: 24, customer_name: 'Second customer', operational_unread_count: '2' },
      { id: 12, customer_name: 'First customer', assigned_member_name: 'Support member', operational_unread_count: 4 },
    ]);
    expect(result.map(ticket => ticket.id)).toEqual([12, 24, 36]);
    expect(result[0]).toMatchObject({ subject: 'First', assignedMemberId: 5, assignedMemberName: 'Support member', operationalUnreadCount: 4 });
    expect(result[1]).toMatchObject({ customerName: 'Second customer', operationalUnreadCount: 2 });
    expect(result[2]).toMatchObject({ customerName: 'Unlinked customer', assignedMemberName: null, operationalUnreadCount: 0 });
  });
});
