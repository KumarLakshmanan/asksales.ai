/** Permanently remove Meta Threads support, data, credentials, and schema affordances. */
export async function up(client) {
  // Audit triggers protect normal readiness history, but the retired platform's
  // records are explicitly purged as part of this irreversible removal.
  await client.query(`
    DROP TRIGGER IF EXISTS provider_verification_runs_immutable ON provider_verification_runs;
    DROP TRIGGER IF EXISTS provider_canary_runs_immutable ON provider_canary_runs;
    DROP TRIGGER IF EXISTS social_metric_snapshots_immutable ON social_metric_snapshots;
    DROP TRIGGER IF EXISTS social_competitor_snapshots_immutable ON social_competitor_snapshots;
  `);

  await client.query(`
    DELETE FROM support_privacy_vault
    WHERE channel = 'threads'
       OR conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_media_retrieval_audits
    WHERE channel = 'threads'
       OR conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_media_delivery_parts
    WHERE channel = 'threads'
       OR conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_effect_ledger
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM handoff_queue
    WHERE channel = 'threads'
       OR conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM agent_audit_logs
    WHERE channel = 'threads'
       OR conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM crm_contact_identity_conflicts
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_tickets
    WHERE outreach_conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM proposals
    WHERE outreach_conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM bookings
    WHERE outreach_conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM crm_activities
    WHERE outreach_conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads')
       OR outreach_message_id IN (
         SELECT id FROM outreach_messages
         WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads')
       );
    DELETE FROM followup_sequences
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_delivery_outbox
    WHERE channel = 'threads'
       OR conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_tool_executions
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM support_playbook_runs
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM engagement_inbox_state
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM social_follow_up_schedules
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM outreach_messages
    WHERE conversation_id IN (SELECT id FROM outreach_conversations WHERE channel = 'threads');
    DELETE FROM outreach_conversations WHERE channel = 'threads';
  `);

  await client.query(`
    DELETE FROM social_publish_attempts WHERE platform = 'threads';
    DELETE FROM social_metric_snapshots WHERE platform = 'threads';
    DELETE FROM social_best_time_recommendations WHERE platform = 'threads';
    DELETE FROM social_listening_events WHERE platform = 'threads';
    DELETE FROM social_competitor_snapshots
    WHERE competitor_id IN (SELECT id FROM social_competitors WHERE platform = 'threads');
    DELETE FROM social_competitors WHERE platform = 'threads';
    DELETE FROM media_transcode_jobs WHERE platform = 'threads';
    DELETE FROM content_asset_previews WHERE channel = 'threads';
    DELETE FROM content_assets WHERE channel = 'threads' OR publish_platform = 'threads';
    DELETE FROM leads WHERE platform_type = 'threads';
    DELETE FROM channel_credentials WHERE platform = 'threads_api';
    DELETE FROM provider_verification_runs WHERE platform = 'threads';
    DELETE FROM provider_canary_runs WHERE platform = 'threads';
    UPDATE engagement_saved_replies
    SET channels = COALESCE((
      SELECT jsonb_agg(value)
      FROM jsonb_array_elements(channels) AS item(value)
      WHERE value <> '"threads"'::jsonb
    ), '[]'::jsonb)
    WHERE channels @> '["threads"]'::jsonb;
  `);

  await client.query(`
    DROP TABLE IF EXISTS social_provider_events, threads_sync_states, threads_monitors;
    DROP INDEX IF EXISTS social_provider_events_threads_inbox_idx;
    DROP INDEX IF EXISTS outreach_messages_threads_provider_uq;
    DROP INDEX IF EXISTS outreach_conversations_threads_root_uq;
    DROP INDEX IF EXISTS leads_threads_provider_identity_uq;
    DROP INDEX IF EXISTS leads_threads_handle_idx;
  `);

  await client.query('DROP INDEX IF EXISTS outreach_conversations_single_channel_uq');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_single_channel_uq
      ON outreach_conversations(user_id, lead_id, channel)
      WHERE channel NOT IN ('email', 'gmail', 'facebook', 'instagram');
  `);

  await client.query(`
    ALTER TABLE leads DROP COLUMN IF EXISTS threads_url, DROP COLUMN IF EXISTS threads_handle;
    ALTER TABLE social_publish_attempts DROP CONSTRAINT IF EXISTS social_publish_attempts_platform_check;
    ALTER TABLE social_publish_attempts ADD CONSTRAINT social_publish_attempts_platform_check
      CHECK (platform IN ('instagram', 'facebook', 'youtube'));
    ALTER TABLE social_metric_snapshots DROP CONSTRAINT IF EXISTS social_metric_snapshots_platform_check;
    ALTER TABLE social_metric_snapshots ADD CONSTRAINT social_metric_snapshots_platform_check
      CHECK (platform IN ('facebook', 'instagram', 'youtube'));
    ALTER TABLE provider_verification_runs DROP CONSTRAINT IF EXISTS provider_verification_runs_platform_check;
    ALTER TABLE provider_verification_runs ADD CONSTRAINT provider_verification_runs_platform_check
      CHECK (platform IN ('facebook', 'instagram', 'whatsapp', 'meta_ads', 'youtube', 'gmail', 'resend'));
    ALTER TABLE provider_canary_runs DROP CONSTRAINT IF EXISTS provider_canary_runs_platform_check;
    ALTER TABLE provider_canary_runs ADD CONSTRAINT provider_canary_runs_platform_check
      CHECK (platform IN ('facebook', 'instagram', 'whatsapp', 'youtube', 'gmail', 'resend'));
  `);

  await client.query(`
    UPDATE admin_api_credentials
    SET config = COALESCE(config, '{}'::jsonb)
      - 'threadsAppId' - 'threadsAppSecret' - 'threadsApiVersion'
      - 'threadsAppReviewPermissions', updated_at = NOW()
    WHERE platform = 'meta_app';
  `);

  await client.query(`
    CREATE TRIGGER provider_verification_runs_immutable
      BEFORE UPDATE OR DELETE ON provider_verification_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_provider_audit_mutation();
    CREATE TRIGGER provider_canary_runs_immutable
      BEFORE UPDATE OR DELETE ON provider_canary_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_provider_audit_mutation();
    CREATE TRIGGER social_metric_snapshots_immutable
      BEFORE UPDATE OR DELETE ON social_metric_snapshots
      FOR EACH ROW EXECUTE FUNCTION prevent_social_metric_snapshot_mutation();
    CREATE TRIGGER social_competitor_snapshots_immutable
      BEFORE UPDATE OR DELETE ON social_competitor_snapshots
      FOR EACH ROW EXECUTE FUNCTION prevent_social_competitor_snapshot_mutation();
  `);
}

export async function down() {
  throw new Error('Migration 250 is irreversible: Meta Threads data and schema have been removed.');
}

export const irreversible = true;
