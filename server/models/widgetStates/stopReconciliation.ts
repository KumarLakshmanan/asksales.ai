import { sql, type SQL } from 'drizzle-orm';

/** Exact action receipts only; never attach the latest action for a campaign. */
export async function reconcileStopWidgets(executor: { execute: (query: SQL) => Promise<{ rows: unknown[] }> }): Promise<number> {
  const result = await executor.execute(sql`
    WITH stops AS (
      SELECT widget.id,
        BOOL_AND(COALESCE(action.status = 'succeeded' AND (
          action.provider_outcome->>'status' = 'paused' OR
          (action.provider_outcome->>'launchCancelled' = 'true' AND COALESCE(action.provider_outcome->>'requiresReconciliation', 'false') = 'false')
        ), FALSE)) AS resolved,
        jsonb_agg(jsonb_build_object('platform', action.platform, 'actionId', action.id,
          'status', action.status, 'providerOutcome', action.provider_outcome, 'error', action.last_error)) AS receipts
      FROM widget_states widget
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(widget.execution_result->'output'->'platforms') = 'array'
        THEN widget.execution_result->'output'->'platforms' ELSE '[]'::jsonb END) receipt
      LEFT JOIN ad_action_queue action ON action.id::text = receipt->>'actionId'
        AND action.user_id = widget.user_id AND action.action_type = 'pause'
        AND action.platform = receipt->>'platform'
        AND action.campaign_id::text = widget.execution_result->'output'->>'campaignId'
      WHERE widget.tool_name = 'stop_ads' AND widget.status = 'queued'
      GROUP BY widget.id
      HAVING COUNT(action.id) = COUNT(*) AND BOOL_AND(action.status IN ('succeeded', 'failed', 'cancelled'))
    )
    UPDATE widget_states widget SET status = CASE WHEN stops.resolved THEN 'succeeded' ELSE 'failed' END,
      execution_result = COALESCE(widget.execution_result, '{}'::jsonb) || jsonb_build_object(
        'completionNotification', jsonb_build_object('status', 'pending', 'eventId', 'widget-stop-completed:' || widget.id::text),
        'success', COALESCE(stops.resolved, FALSE),
        'output', COALESCE(widget.execution_result->'output', '{}'::jsonb) || jsonb_build_object(
          'status', CASE WHEN stops.resolved THEN 'succeeded' ELSE 'failed' END,
          'platforms', stops.receipts,
          'message', CASE WHEN stops.resolved THEN 'Stop requests completed. See each platform receipt for provider pause or pre-launch cancellation.'
            ELSE 'A stop request needs attention. Do not assume ads or spend have stopped; inspect each provider receipt.' END)),
      execution_error = CASE WHEN stops.resolved THEN NULL ELSE 'One or more platform stops require attention.' END,
      execution_completed_at = NOW(), updated_at = NOW()
    FROM stops WHERE widget.id = stops.id RETURNING widget.id
  `);
  return result.rows.length;
}
