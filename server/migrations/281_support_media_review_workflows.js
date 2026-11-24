export async function up(client) {
  await client.query(`ALTER TABLE support_media_gallery_versions ADD COLUMN IF NOT EXISTS metadata_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await client.query(`UPDATE support_media_gallery_versions v SET metadata_snapshot=jsonb_build_object(
    'title',g.title,'description',g.description,'business_profile_id',g.business_profile_id,'audience',g.audience,
    'usage_scopes',g.usage_scopes,'allowed_channels',g.allowed_channels,'locale',g.locale,'product_scope',g.product_scope,
    'entity_tags',g.entity_tags,'helpful_auto_attach',g.helpful_auto_attach)
    FROM support_media_galleries g WHERE g.id=v.gallery_id AND v.metadata_snapshot='{}'::jsonb`);
  await client.query(`CREATE TABLE IF NOT EXISTS support_media_review_audits (
    id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
    asset_id bigint REFERENCES support_media_assets(id), delivery_part_id bigint REFERENCES support_media_delivery_parts(id),
    decision varchar(40) NOT NULL, reason text NOT NULL, provider_message_id varchar(255), created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await client.query(`ALTER TABLE support_media_review_audits ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE support_media_review_audits FORCE ROW LEVEL SECURITY`);
  await client.query(`CREATE POLICY support_media_review_audits_tenant ON support_media_review_audits
    USING (user_id = NULLIF(current_setting('app.current_user_id',true),'')::integer)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id',true),'')::integer)`);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_media_review_audits');
  await client.query('ALTER TABLE support_media_gallery_versions DROP COLUMN IF EXISTS metadata_snapshot');
}
