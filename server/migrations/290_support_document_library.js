export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS support_document_library (
    id bigserial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id),
    business_profile_id integer REFERENCES company_settings(id),
    storage_file_id integer NOT NULL REFERENCES storage_files(id),
    title varchar(180) NOT NULL,
    description text NOT NULL DEFAULT '',
    service varchar(40) NOT NULL,
    checksum varchar(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
    current_approval_id bigint REFERENCES support_approved_documents(id),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,storage_file_id)
  )`);
  await client.query('ALTER TABLE support_document_library ENABLE ROW LEVEL SECURITY');
  await client.query('ALTER TABLE support_document_library FORCE ROW LEVEL SECURITY');
  await client.query(`CREATE POLICY support_document_library_tenant ON support_document_library
    USING (user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer)
    WITH CHECK (user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer)`);
  await client.query('CREATE INDEX support_document_library_scope ON support_document_library(user_id,service,status)');
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_document_library');
}
