import { sql } from 'drizzle-orm';

/** Current workload includes older unresolved tickets; intake charts use their own date range. */
export function currentSupportQueueQuery(userId: number) {
  return sql`SELECT COUNT(*) FILTER (WHERE status='open')::int AS open_tickets,
    COUNT(*)::int AS active_tickets,
    COUNT(*) FILTER (WHERE status='waiting_on_customer')::int AS waiting_tickets,
    COUNT(*) FILTER (WHERE sla_deadline < NOW())::int AS sla_breaches,
    COUNT(*) FILTER (WHERE sla_deadline IS NOT NULL)::int AS tickets_with_sla
    FROM support_tickets
    WHERE user_id=${userId} AND deleted_at IS NULL
      AND status IN ('open','in_progress','waiting_on_customer')`;
}
