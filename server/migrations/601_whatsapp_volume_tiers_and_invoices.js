// WhatsApp platform billing, monthly matching with Meta.
//
// whatsapp_rate_tiers: Meta's volume-tier rates for utility and authentication
//   messages. Meta counts a business portfolio's delivered, charged messages
//   per market and category each month, and prices them incrementally: only
//   messages from volume_from to volume_to get that tier's rate. Customers are
//   still charged the list rate (rate cards); tiers only work out what Meta
//   should bill us, for the monthly statement.
// whatsapp_billing_invoices: the total of Meta's (or the partner's) invoice per
//   month and currency, entered by an administrator to match against our ledger.
//
// Both are platform-wide (global) tables, edited by administrators.
const GLOBAL_TABLES = ['whatsapp_rate_tiers', 'whatsapp_billing_invoices'];

export async function up(client) {
  await client.query(`
    CREATE TABLE whatsapp_rate_tiers (
      id serial PRIMARY KEY,
      market varchar(80) NOT NULL,
      category varchar(24) NOT NULL CHECK (category IN ('utility','authentication')),
      currency char(3) NOT NULL,
      effective_from date NOT NULL,
      volume_from integer NOT NULL CHECK (volume_from >= 0),
      volume_to integer CHECK (volume_to IS NULL OR volume_to >= volume_from),
      rate numeric(14,6) NOT NULL CHECK (rate >= 0),
      source varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (market, category, currency, effective_from, volume_from)
    );

    CREATE TABLE whatsapp_billing_invoices (
      month date NOT NULL CHECK (month = date_trunc('month', month)::date),
      currency char(3) NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount >= 0),
      reference varchar(120),
      note text,
      entered_by integer,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (month, currency)
    );

    GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_rate_tiers, whatsapp_billing_invoices TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE whatsapp_rate_tiers_id_seq TO salesmarketing_business_runtime;
  `);
  for (const table of GLOBAL_TABLES) {
    await client.query('INSERT INTO business_scope_accounts(table_name) VALUES($1) ON CONFLICT DO NOTHING', [table]);
  }
}

export async function down(client) {
  await client.query('DELETE FROM business_scope_accounts WHERE table_name = ANY($1::text[])', [GLOBAL_TABLES]);
  await client.query('DROP TABLE IF EXISTS whatsapp_billing_invoices, whatsapp_rate_tiers');
}
