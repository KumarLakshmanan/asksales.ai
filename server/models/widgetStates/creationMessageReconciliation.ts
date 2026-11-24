import { sql } from 'drizzle-orm';

/** Shared composer batches persist message IDs, not legacy outreach-job IDs.
 * Reconcile only exact initial messages bound to this review, tenant and chat.
 * This reads receipts and updates review status; it never retries delivery. */
export function creationMessageReconciliation() {
  return sql`
    WITH receipts AS (
      SELECT w.id AS widget_id, w.user_id, w.business_profile_id, w.thread_id,
        CASE WHEN jsonb_typeof(w.execution_result->'output'->'results') = 'array'
          THEN jsonb_array_length(w.execution_result->'output'->'results') ELSE 0 END AS expected,
        CASE WHEN r->>'messageId' ~ '^[0-9]{1,10}$' THEN (r->>'messageId')::bigint END AS message_id,
        CASE WHEN r->>'leadId' ~ '^[0-9]{1,10}$' THEN (r->>'leadId')::bigint END AS lead_id, m.status,
        CASE
          WHEN m.id IS NULL OR c.id IS NULL THEN 'unavailable'
          WHEN m.provider_call_state = 'unknown' OR m.status = 'manual_review' THEN 'uncertain'
          WHEN m.status = 'failed' AND m.metadata#>>'{outreachQueue,enqueueNeeded}' = 'true' THEN 'open'
          WHEN m.status IN ('failed', 'bounced', 'cancelled', 'setup_required') THEN 'failed'
          WHEN m.provider_call_state = 'confirmed' AND m.status IN ('sent', 'delivered', 'read') THEN 'accepted'
          ELSE 'open'
        END AS outcome
      FROM widget_states w
      CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN jsonb_typeof(w.execution_result->'output'->'results') = 'array'
          THEN w.execution_result->'output'->'results' ELSE '[]'::jsonb END) r
      LEFT JOIN outreach_messages m ON m.id = CASE
        WHEN r->>'messageId' ~ '^[0-9]{1,10}$' THEN (r->>'messageId')::bigint END
        AND m.user_id = w.user_id AND m.business_profile_id = w.business_profile_id
        AND m.direction = 'outbound' AND m.message_kind = 'outreach'
        AND m.metadata#>>'{outreachCreation,delivery,widgetId}' = w.id::text
        AND m.metadata#>>'{outreachCreation,delivery,threadId}' = w.thread_id::text
      LEFT JOIN outreach_conversations c ON c.id = m.conversation_id
        AND c.user_id = w.user_id AND c.business_profile_id = w.business_profile_id
        AND c.channel = w.execution_result->'output'->>'channel'
        AND c.lead_id = CASE WHEN r->>'leadId' ~ '^[0-9]{1,10}$' THEN (r->>'leadId')::bigint END
      WHERE w.tool_name = 'send_outreach_messages' AND w.status = 'queued'
        AND COALESCE(w.submitted_values,w.form_values,'{}'::jsonb)#>>'{outreach_review,creationVersion}' = '1'
    ), counts AS (
      SELECT widget_id, user_id, business_profile_id, thread_id, expected,
        COUNT(*) AS matched, COUNT(DISTINCT message_id) AS distinct_messages,
        COUNT(DISTINCT lead_id) AS distinct_leads,
        COUNT(*) FILTER (WHERE outcome = 'accepted') AS accepted,
        COUNT(*) FILTER (WHERE outcome = 'accepted' AND status IN ('delivered', 'read')) AS delivered,
        COUNT(*) FILTER (WHERE outcome = 'failed') AS failed,
        COUNT(*) FILTER (WHERE outcome = 'uncertain') AS uncertain,
        COUNT(*) FILTER (WHERE outcome = 'unavailable') AS unavailable,
        COUNT(*) FILTER (WHERE outcome = 'open') AS open_count
      FROM receipts GROUP BY widget_id, user_id, business_profile_id, thread_id, expected
    )
    UPDATE widget_states w SET
      status = CASE WHEN n.failed + n.uncertain + n.unavailable > 0 THEN 'failed' ELSE 'succeeded' END,
      execution_result = COALESCE(w.execution_result, '{}'::jsonb) || jsonb_build_object(
        'success', n.failed + n.uncertain + n.unavailable = 0,
        'output', COALESCE(w.execution_result->'output', '{}'::jsonb) || jsonb_build_object(
          'status', CASE WHEN n.uncertain + n.unavailable > 0 THEN 'needs_attention'
            WHEN n.failed > 0 THEN 'failed' ELSE 'succeeded' END,
          'success', n.failed + n.uncertain + n.unavailable = 0, 'successCount', n.accepted,
          'failCount', n.failed, 'uncertainCount', n.uncertain, 'unavailableCount', n.unavailable, 'retrySafe', false,
          'message', concat(n.accepted, ' provider-accepted, ', n.delivered, ' delivered/read, ', n.failed, ' failed, ', n.uncertain, ' uncertain, ', n.unavailable, ' unavailable. Check delivery details.')),
        'reconciliation', jsonb_build_object('source', 'outreach_messages',
          'acceptedCount', n.accepted, 'deliveredCount', n.delivered,
          'failedCount', n.failed, 'uncertainCount', n.uncertain, 'unavailableCount', n.unavailable)),
      execution_error = CASE WHEN n.unavailable > 0 THEN 'A reviewed message receipt is unavailable; check delivery history before retrying'
        WHEN n.uncertain > 0 THEN 'Delivery confirmation needs review; check recorded outcomes before retrying'
        WHEN n.failed > 0 THEN 'One or more outreach messages failed; review delivery details before retrying'
        ELSE NULL END,
      execution_completed_at = NOW(), updated_at = NOW()
    FROM counts n WHERE w.id = n.widget_id AND w.user_id = n.user_id
      AND w.business_profile_id = n.business_profile_id AND w.thread_id = n.thread_id AND w.status = 'queued'
      AND n.expected >= 1 AND n.matched = n.expected
      AND n.distinct_messages = n.expected AND n.distinct_leads = n.expected AND n.open_count = 0
    RETURNING w.id
  `;
}
