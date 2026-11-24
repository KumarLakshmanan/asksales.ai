/**
 * Retire the standalone Content Creator approval workflow without deleting its
 * immutable history. Publishing no longer consumes this policy, so pending
 * requests are closed and active workflows are disabled before the UI and API
 * surface disappear.
 */
export const irreversible = true;

export async function up(client) {
  await client.query(`
    INSERT INTO content_approval_audit_events (
      request_id,
      owner_user_id,
      actor_user_id,
      event_type,
      event_data,
      created_at
    )
    SELECT
      request.id,
      request.owner_user_id,
      NULL,
      'feature_retired',
      jsonb_build_object(
        'previousStatus', request.status,
        'previousStage', request.current_stage_position,
        'reason', 'The standalone content approval workflow was retired.'
      ),
      NOW()
    FROM content_approval_requests request
    WHERE request.status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM content_approval_audit_events audit
        WHERE audit.request_id = request.id
          AND audit.event_type = 'feature_retired'
      );

    UPDATE content_assets asset
    SET approval_status = 'draft',
        approved_by = NULL,
        approved_at = NULL,
        updated_at = NOW()
    FROM content_approval_requests request
    WHERE request.asset_id = asset.id
      AND request.asset_version = asset.version
      AND request.status = 'pending'
      AND asset.approval_status <> 'rejected'
      AND NOT EXISTS (
        SELECT 1
        FROM ai_visibility_asset_approval_decisions decision
        WHERE decision.content_asset_id = asset.id
          AND decision.asset_version = asset.version
          AND decision.decision = 'approved'
      );

    UPDATE content_approval_requests
    SET status = 'cancelled',
        decided_at = COALESCE(decided_at, NOW()),
        updated_at = NOW()
    WHERE status = 'pending';

    UPDATE content_approval_workflows
    SET is_active = FALSE,
        updated_at = NOW()
    WHERE is_active = TRUE;
  `);
}

// This retirement preserves historical decisions and audit events. Reopening
// old workflows would restore a policy that the application no longer serves.
export async function down() {
  throw new Error('204_retire_content_approval_workflows is irreversible');
}
