export async function up(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS support_approved_documents (
    id bigserial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id),
    business_profile_id integer REFERENCES company_settings(id),
    storage_file_id integer NOT NULL REFERENCES storage_files(id),
    title varchar(180) NOT NULL,
    service varchar(40) NOT NULL,
    checksum varchar(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    status varchar(20) NOT NULL DEFAULT 'published' CHECK (status IN ('published','withdrawn')),
    approval_reason text NOT NULL,
    approved_by integer NOT NULL REFERENCES users(id),
    approved_at timestamptz NOT NULL DEFAULT NOW(),
    expires_at timestamptz,
    withdrawn_at timestamptz,
    withdrawal_reason text,
    UNIQUE(user_id,storage_file_id,service,checksum),
    CHECK (approved_by=user_id)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS support_approved_documents_lookup
    ON support_approved_documents(user_id,service,status)`);
  await client.query('ALTER TABLE support_approved_documents ENABLE ROW LEVEL SECURITY');
  await client.query('ALTER TABLE support_approved_documents FORCE ROW LEVEL SECURITY');
  await client.query(`CREATE POLICY support_approved_documents_tenant ON support_approved_documents
    USING (user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer)
    WITH CHECK (user_id=NULLIF(current_setting('app.current_user_id',true),'')::integer)`);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS support_approved_documents');
}
