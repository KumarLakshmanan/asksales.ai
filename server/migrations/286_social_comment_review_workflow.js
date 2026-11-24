export async function up(client) {
  await client.query(`ALTER TABLE social_comment_workflows
    DROP CONSTRAINT IF EXISTS social_comment_workflows_status_check,
    ADD CONSTRAINT social_comment_workflows_status_check CHECK(status IN ('open','reviewed','follow_up','escalated','resolved'))`);
  // Keep existing live-thread actions authoritative. Migrate only official,
  // account-owned comment review state; manual notes and tags stay separate.
  await client.query(`INSERT INTO social_comment_workflows(user_id,credential_id,post_id,comment_id,status)
    SELECT events.user_id,content.credential_id,content.provider_id,events.provider_event_id,
      CASE WHEN events.metadata->>'reviewStatus'='new' THEN 'open' ELSE events.metadata->>'reviewStatus' END
    FROM social_listening_events events
    JOIN social_content_items content ON content.user_id=events.user_id
      AND content.credential_id::text=events.metadata->>'credentialId'
      AND content.provider_id=events.metadata->>'contentId' AND content.platform=events.platform
    WHERE events.source='official_api' AND events.metadata->>'collection'='owned_post_comments'
      AND events.provider_event_id ~ '^[0-9_]+$'
      AND events.metadata->>'reviewStatus' IN ('new','reviewed','follow_up','escalated','resolved')
    ON CONFLICT(user_id,credential_id,comment_id) DO NOTHING`);
}
export async function down(client) {
  await client.query(
    "UPDATE social_comment_workflows SET status='open' WHERE status='reviewed'",
  );
  await client.query(`ALTER TABLE social_comment_workflows
    DROP CONSTRAINT IF EXISTS social_comment_workflows_status_check,
    ADD CONSTRAINT social_comment_workflows_status_check CHECK(status IN ('open','follow_up','escalated','resolved'))`);
}
