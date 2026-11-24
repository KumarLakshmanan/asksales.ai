/** A durable holder protects an exact owned object revision. No object IO here. */
export const irreversible = true;
export async function up(client) {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS storage_files_managed_identity_uq
      ON storage_files(id,user_id,business_profile_id,storage_backend,storage_key);
    CREATE TABLE IF NOT EXISTS storage_managed_references (
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE RESTRICT,
      reference_type varchar(100) NOT NULL CHECK(length(reference_type)>0),
      reference_id varchar(255) NOT NULL CHECK(length(reference_id)>0),
      storage_file_id integer NOT NULL,
      storage_backend varchar(20) NOT NULL,
      storage_key varchar(1000) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(business_profile_id,user_id,reference_type,reference_id,storage_file_id),
      FOREIGN KEY(storage_file_id,user_id,business_profile_id,storage_backend,storage_key)
        REFERENCES storage_files(id,user_id,business_profile_id,storage_backend,storage_key)
        ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS storage_managed_object_idx ON storage_managed_references
      (business_profile_id,user_id,storage_file_id);
    CREATE INDEX IF NOT EXISTS storage_managed_key_idx ON storage_managed_references
      (user_id,storage_backend,storage_key);
    ALTER TABLE storage_managed_references ENABLE ROW LEVEL SECURITY;
    ALTER TABLE storage_managed_references FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS business_isolation ON storage_managed_references;
    CREATE POLICY business_isolation ON storage_managed_references FOR ALL
      USING(app_business_system() OR (business_profile_id=app_business_profile_id() AND user_id=app_business_user_id()))
      WITH CHECK(app_business_system() OR (business_profile_id=app_business_profile_id() AND user_id=app_business_user_id()));
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage_managed_references TO salesmarketing_business_runtime;
  `);
  const spec = {
    table_name: "storage_managed_references",
    owner_column: "user_id",
    global_read: false,
    parent_links: [
      {
        parent: "storage_files",
        child_columns: ["storage_file_id"],
        parent_columns: ["id"],
      },
    ],
    legacy_business_column: null,
  };
  await client.query(
    `INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links)
    VALUES('storage_managed_references','user_id',false,$1::jsonb)
    ON CONFLICT(table_name) DO UPDATE SET parent_links=EXCLUDED.parent_links`,
    [JSON.stringify(spec.parent_links)],
  );
  await client.query(`DROP TRIGGER IF EXISTS business_ownership_guard ON storage_managed_references;
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON storage_managed_references
    NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${JSON.stringify(spec)}');
    CREATE OR REPLACE FUNCTION storage_validate_managed_reference() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE f storage_files%ROWTYPE;
    BEGIN
      PERFORM o.id FROM billing_organizations o JOIN company_settings p ON p.billing_organization_id=o.id
        WHERE p.id=NEW.business_profile_id AND p.user_id=NEW.user_id ORDER BY o.id FOR UPDATE OF o;
      PERFORM pg_advisory_xact_lock(hashtextextended('storage-managed:'||NEW.user_id||':'||NEW.business_profile_id,0));
      PERFORM pg_advisory_xact_lock(hashtextextended('storage-object:'||NEW.user_id||':'||
        CASE WHEN NEW.storage_backend='aws' THEN 's3' ELSE NEW.storage_backend END||':'||NEW.storage_key,0));
      SELECT * INTO f FROM storage_files WHERE id=NEW.storage_file_id AND user_id=NEW.user_id
        AND business_profile_id=NEW.business_profile_id FOR SHARE;
      IF NOT FOUND OR f.is_deleted OR f.metadata #>> '{storageWorkspace,trashedAt}' IS NOT NULL
        OR f.storage_key<>NEW.storage_key OR f.storage_backend<>NEW.storage_backend THEN
        RAISE EXCEPTION 'Managed storage revision is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS storage_managed_revision_guard ON storage_managed_references;
    CREATE TRIGGER storage_managed_revision_guard BEFORE INSERT OR UPDATE ON storage_managed_references
      FOR EACH ROW EXECUTE FUNCTION storage_validate_managed_reference();
    CREATE OR REPLACE FUNCTION storage_preserve_managed_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.is_deleted OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
        OR NEW.storage_backend IS DISTINCT FROM OLD.storage_backend OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.business_profile_id IS DISTINCT FROM OLD.business_profile_id THEN
        IF EXISTS(SELECT 1 FROM storage_managed_references WHERE storage_file_id=OLD.id AND user_id=OLD.user_id) THEN
          RAISE EXCEPTION 'Managed storage revision still has durable references' USING ERRCODE='23514';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS storage_preserve_managed_revision ON storage_files;
    CREATE TRIGGER storage_preserve_managed_revision BEFORE DELETE OR UPDATE OF
      is_deleted,storage_key,storage_backend,user_id,business_profile_id ON storage_files
      FOR EACH ROW EXECUTE FUNCTION storage_preserve_managed_revision();
  `);
  // Preserve existing durable copies. No expiry inference and no provider IO.
  // Only exact, already-owned managed rows are claimed; missing/external URLs
  // are not imported or assigned ownership by this backfill.
  // Content persists some media documents as JSON text. Walk those encoded
  // documents too, without failing enrollment on ordinary/malformed prose.
  // Iteration avoids a second application projector or recursive SQL functions;
  // the helper exists only in this migration connection's temporary namespace.
  await client.query(`CREATE OR REPLACE FUNCTION pg_temp.storage_managed_snapshot_strings(document jsonb)
    RETURNS SETOF text LANGUAGE plpgsql AS $$
    DECLARE pending jsonb[] := ARRAY[COALESCE(document,'{}'::jsonb)]; current_document jsonb; item text; decoded jsonb;
    BEGIN
      WHILE cardinality(pending)>0 LOOP
        current_document := pending[1]; pending := pending[2:];
        FOR item IN SELECT value #>> '{}' FROM jsonb_path_query(current_document,'$.** ? (@.type() == "string")') value LOOP
          RETURN NEXT item;
          IF left(ltrim(item),1) IN ('{','[') THEN
            BEGIN decoded := item::jsonb; EXCEPTION WHEN data_exception THEN decoded := NULL; END;
            IF jsonb_typeof(decoded) IN ('object','array') THEN pending := array_append(pending,decoded); END IF;
          END IF;
        END LOOP;
      END LOOP;
    END $$`);
  const sources = [
    [
      "brand_toolkits",
      "brand_toolkit",
      `jsonb_build_object('logoUrl',logo_url,'logoUrls',logo_urls,'imageAssets',image_assets,'websiteScreenshotUrl',website_screenshot_url)`,
    ],
    ["content_assets", "content_asset", "to_jsonb(d)"],
    ["content_templates", "content_template", "to_jsonb(d)"],
    ["content_template_versions", "content_template_version", "to_jsonb(d)"],
    ["social_publish_attempts", "social_publish_attempt", "to_jsonb(d)"],
  ];
  await client.query("SELECT set_config('app.business_system','on',true)");
  for (const [table, type, document] of sources) {
    await client.query(
      `WITH leaves AS MATERIALIZED (
        SELECT d.user_id,d.business_profile_id,d.id::text AS reference_id,
          regexp_replace(leaf.url,'[?#].*$','') AS url
        FROM ${table} d CROSS JOIN LATERAL pg_temp.storage_managed_snapshot_strings(${document}) leaf(url)
      ), objects AS MATERIALIZED (
        SELECT f.id,f.user_id,f.business_profile_id,f.storage_backend,f.storage_key,aliases.url
        FROM storage_files f CROSS JOIN LATERAL (VALUES
          (regexp_replace(f.url,'[?#].*$','')),
          ('/api/settings/storage/files/'||f.id::text||'/download')
        ) aliases(url)
        WHERE NOT f.is_deleted AND f.metadata #>> '{storageWorkspace,trashedAt}' IS NULL
      )
      INSERT INTO storage_managed_references(user_id,business_profile_id,reference_type,reference_id,
      storage_file_id,storage_backend,storage_key)
      SELECT DISTINCT d.user_id,d.business_profile_id,$1,d.reference_id,f.id,f.storage_backend,f.storage_key
      FROM leaves d JOIN objects f ON f.user_id=d.user_id
        AND f.business_profile_id=d.business_profile_id AND f.url=d.url
      ON CONFLICT DO NOTHING`,
      [type],
    );
  }
}
export async function down() {
  throw new Error(
    "Managed reference protection requires coordinated rollback; do not discard live reference accounting.",
  );
}
