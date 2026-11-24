/**
 * WhatsApp platform billing ("we pay Meta").
 *
 * When a customer's WhatsApp Business Account (WABA) runs on our shared Meta
 * credit line, Meta bills us for every delivered message. These tables let us
 * price each message at Meta's rate plus our margin, reserve that from the
 * customer's wallet before sending, and settle it from the delivery webhook.
 *
 * Nothing changes for any customer until both:
 *   - WHATSAPP_PLATFORM_BILLING_ENABLED=true, and
 *   - their WABA has a whatsapp_billing_accounts row with billing_mode='platform'.
 * See docs/WHATSAPP_PLATFORM_BILLING_PLAN.md.
 *
 * Tables:
 *   whatsapp_rate_markets         calling code -> Meta rate-card market (global, admin edited)
 *   whatsapp_rate_cards           Meta list rate per market/category/currency, versioned (global, admin edited)
 *   whatsapp_billing_accounts     which WABAs Meta bills to us, their caps and credit-line state (global, admin edited)
 *   whatsapp_billing_reconciliation  Meta's reported cost per WABA/day/category vs our ledger (global)
 *   whatsapp_message_charges      one row per billed send (business scoped, RLS)
 * Admin-editable credit_pricing rows:
 *   whatsapp_margin_{marketing,utility,authentication,service}  percent on Meta's rate (0% until set)
 *   whatsapp_free_message_fee     credits for a message Meta did not charge (0 until set)
 *   outreach_whatsapp_platform    flat per-message fee on platform-billed WABAs, charged
 *                                 on top of Meta's cost where outreach_whatsapp is charged today
 *                                 (starts at the current outreach_whatsapp value)
 * Plus a unique index so each charge has one reservation and at most one top-up.
 */

const ADMIN_ONLY = [
  ['whatsapp_margin_marketing', 'WhatsApp marketing margin', 'Percent added to Meta\'s marketing message rate', '0', 'percent margin'],
  ['whatsapp_margin_utility', 'WhatsApp utility margin', 'Percent added to Meta\'s utility message rate', '0', 'percent margin'],
  ['whatsapp_margin_authentication', 'WhatsApp authentication margin', 'Percent added to Meta\'s authentication message rate', '0', 'percent margin'],
  ['whatsapp_margin_service', 'WhatsApp service margin', 'Percent added to Meta\'s service (reply) message rate', '0', 'percent margin'],
  ['whatsapp_free_message_fee', 'WhatsApp fee when Meta does not charge', 'Credits per delivered message that Meta reports as free (free tier, free entry point)', '0', 'credits per message'],
];

async function seedPrice(client, [key, name, description, category, credits, unit, sort]) {
  const inserted = await client.query(
    `INSERT INTO credit_pricing(event_key, name, description, category, credits_per_unit, unit_label, sort_order, is_active)
     VALUES($1, $2, $3, $4, $5, $6, $7, true) ON CONFLICT(event_key) DO NOTHING RETURNING *`,
    [key, name, description, category, credits, unit, sort],
  );
  const row = inserted.rows[0];
  if (!row) return;
  await client.query(
    `INSERT INTO pricing_change_audit(domain, record_id, pricing_key, action, after_value)
     VALUES('credit_pricing', $1, $2, 'seed', $3::jsonb)`,
    [row.id, row.event_key, JSON.stringify({ id: row.id, eventKey: row.event_key, name: row.name, category: row.category,
      creditsPerUnit: String(row.credits_per_unit), unitLabel: row.unit_label, isActive: row.is_active })],
  );
}

export async function up(client) {
  await client.query(`
    CREATE TABLE whatsapp_rate_markets (
      calling_code varchar(8) PRIMARY KEY CHECK (calling_code ~ '^[0-9]{1,8}$'),
      market varchar(80) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE whatsapp_rate_cards (
      id serial PRIMARY KEY,
      market varchar(80) NOT NULL,
      category varchar(24) NOT NULL CHECK (category IN ('marketing','utility','authentication','service')),
      currency char(3) NOT NULL,
      rate numeric(14,6) NOT NULL CHECK (rate >= 0),
      effective_from date NOT NULL,
      source varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (market, category, currency, effective_from)
    );

    CREATE TABLE whatsapp_billing_accounts (
      waba_id varchar(64) PRIMARY KEY,
      billing_mode varchar(16) NOT NULL DEFAULT 'customer_own' CHECK (billing_mode IN ('platform','customer_own')),
      currency char(3) NOT NULL DEFAULT 'INR',
      daily_spend_cap_credits numeric(12,2) CHECK (daily_spend_cap_credits IS NULL OR daily_spend_cap_credits >= 0),
      allocation_config_id varchar(64),
      credit_line_status varchar(16) NOT NULL DEFAULT 'none'
        CHECK (credit_line_status IN ('none','attached','failed','revoked')),
      credit_line_error text,
      attached_at timestamptz,
      revoked_at timestamptz,
      user_id integer,
      business_profile_id integer,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE whatsapp_billing_reconciliation (
      id serial PRIMARY KEY,
      waba_id varchar(64) NOT NULL,
      day date NOT NULL,
      category varchar(40) NOT NULL,
      meta_volume integer NOT NULL DEFAULT 0,
      meta_cost numeric(14,6) NOT NULL DEFAULT 0,
      currency char(3) NOT NULL,
      ledger_volume integer NOT NULL DEFAULT 0,
      ledger_cost numeric(14,6) NOT NULL DEFAULT 0,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (waba_id, day, category)
    );

    INSERT INTO whatsapp_rate_markets(calling_code, market) VALUES ('91', 'India') ON CONFLICT DO NOTHING;

    -- Administrators edit these through the API, which runs as the runtime role.
    GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_rate_markets, whatsapp_rate_cards, whatsapp_billing_accounts,
      whatsapp_billing_reconciliation TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE whatsapp_rate_cards_id_seq, whatsapp_billing_reconciliation_id_seq TO salesmarketing_business_runtime;

    CREATE TABLE whatsapp_message_charges (
      id bigserial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL DEFAULT app_business_profile_id() REFERENCES company_settings(id) ON DELETE CASCADE,
      waba_id varchar(64) NOT NULL,
      phone_number_id varchar(64) NOT NULL,
      wamid varchar(255),
      message_kind varchar(16) NOT NULL CHECK (message_kind IN ('template','service')),
      template_name varchar(512),
      template_language varchar(20),
      expected_category varchar(24) NOT NULL,
      recipient_market varchar(80) NOT NULL,
      currency char(3) NOT NULL,
      reserved_rate numeric(14,6) NOT NULL,
      reserved_credits numeric(12,2) NOT NULL,
      reservation_transaction_id integer,
      status varchar(16) NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved','sent','settled','refunded','needs_review')),
      meta_billable boolean,
      meta_category varchar(40),
      meta_pricing_type varchar(40),
      settled_rate numeric(14,6),
      charged_credits numeric(12,2),
      topup_transaction_id integer,
      pricing_raw jsonb,
      review_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz
    );
    CREATE UNIQUE INDEX whatsapp_message_charges_wamid_uq ON whatsapp_message_charges(phone_number_id, wamid) WHERE wamid IS NOT NULL;
    CREATE INDEX whatsapp_message_charges_open_idx ON whatsapp_message_charges(status, created_at) WHERE status IN ('reserved','sent','needs_review');
    CREATE INDEX whatsapp_message_charges_recent_idx ON whatsapp_message_charges(business_profile_id, user_id, created_at DESC);
    CREATE INDEX whatsapp_message_charges_waba_day_idx ON whatsapp_message_charges(waba_id, created_at);
  `);

  const table = 'whatsapp_message_charges';
  const spec = { table_name: table, owner_column: 'user_id', global_read: false, parent_links: [], legacy_business_column: null };
  await client.query('INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links) VALUES($1,$2,false,$3::jsonb)', [table, 'user_id', '[]']);
  const literal = JSON.stringify(spec).replaceAll("'", "''");
  await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON ${table} FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
    CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON ${table} NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${literal}');
    GRANT SELECT,INSERT,UPDATE ON ${table} TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE whatsapp_message_charges_id_seq TO salesmarketing_business_runtime;`);

  // One reservation and at most one top-up per charge, even when Meta's
  // delivered and read webhooks settle the same message concurrently.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_whatsapp_charge_deduction_uq
      ON wallet_transactions(user_id, reference_type, reference_id)
      WHERE type = 'deduction' AND reference_type IN ('whatsapp_message_charge', 'whatsapp_message_charge_topup')
  `);

  const recharge = await client.query(`SELECT 1 FROM credit_pricing WHERE event_key = 'recharge_rate'`);
  if (!recharge.rows[0]) return;
  // Margins and the free-message fee start at 0 so turning the feature on never
  // invents a price. Their own category keeps them on the admin pricing page and
  // off the customer's Credit costs page, which lists only known categories.
  for (const [key, name, description, credits, unit] of ADMIN_ONLY) {
    await seedPrice(client, [key, name, description, 'whatsapp_margin', credits, unit, 33]);
  }
  // The flat fee for platform-billed WABAs starts at today's WhatsApp outreach
  // price, so switching an account over changes only the Meta cost added on top.
  const current = await client.query(`SELECT credits_per_unit FROM credit_pricing WHERE event_key = 'outreach_whatsapp'`);
  await seedPrice(client, ['outreach_whatsapp_platform', 'WhatsApp Outreach (company-billed)',
    'Platform fee per WhatsApp message on accounts billed through our Meta credit line, added to Meta\'s message cost',
    'outreach', String(current.rows[0]?.credits_per_unit ?? '3'), 'per message', 32]);
}

export async function down(client) {
  // Charge rows are the record of what customers paid for WhatsApp messages.
  // Row security hides them from the migration role unless it reads as the
  // system (same pattern as 594), so check with that set.
  const previous = await client.query("SELECT current_setting('app.business_system',true) AS value");
  await client.query("SELECT set_config('app.business_system','on',true)");
  const used = await client.query('SELECT 1 FROM whatsapp_message_charges LIMIT 1');
  await client.query("SELECT set_config('app.business_system',$1,true)", [previous.rows[0]?.value || 'off']);
  if (used.rows[0]) throw new Error('whatsapp_message_charges has billing history; roll forward instead of dropping it.');
  await client.query(`
    DROP INDEX IF EXISTS wallet_transactions_whatsapp_charge_deduction_uq;
    DROP TABLE whatsapp_message_charges;
    DELETE FROM business_scope_tables WHERE table_name='whatsapp_message_charges';
    DROP TABLE whatsapp_billing_reconciliation;
    DROP TABLE whatsapp_billing_accounts;
    DROP TABLE whatsapp_rate_cards;
    DROP TABLE whatsapp_rate_markets;
  `);
  // Price rows are kept, like other price rows (see 594).
}
