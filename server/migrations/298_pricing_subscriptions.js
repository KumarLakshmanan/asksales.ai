export async function up(db) {
  await db.query(`
    CREATE TABLE subscription_plans (
      version integer NOT NULL, slug text NOT NULL, name text NOT NULL,
      monthly_amount_paise integer NOT NULL CHECK(monthly_amount_paise > 0),
      yearly_amount_paise integer NOT NULL CHECK(yearly_amount_paise > 0),
      monthly_credits integer NOT NULL CHECK(monthly_credits > 0),
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(version, slug)
    );
    INSERT INTO subscription_plans(version,slug,name,monthly_amount_paise,yearly_amount_paise,monthly_credits) VALUES
      (1,'starter','Starter',10000,96000,1000),(1,'basic','Basic',25000,240000,2500),
      (1,'standard','Standard',50000,480000,5000),(1,'popular','Popular',100000,960000,10000),
      (1,'pro','Pro',250000,2400000,25000),(1,'enterprise','Enterprise',500000,4800000,50000);
    CREATE TABLE subscription_settings (
      id integer PRIMARY KEY CHECK(id=1), enforced boolean NOT NULL DEFAULT false,
      launched_at timestamptz, credential_id integer REFERENCES admin_api_credentials(id),
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by integer REFERENCES admins(id)
    );
    INSERT INTO subscription_settings(id) VALUES(1);
    CREATE TABLE subscription_provider_plans (
      credential_id integer NOT NULL REFERENCES admin_api_credentials(id),
      version integer NOT NULL, slug text NOT NULL, term text NOT NULL CHECK(term IN('monthly','yearly')),
      provider_plan_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(version,slug) REFERENCES subscription_plans(version,slug),
      PRIMARY KEY(credential_id,version,slug,term)
    );
    CREATE TABLE billing_subscriptions (
      id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id),
      credential_id integer NOT NULL REFERENCES admin_api_credentials(id),
      mode text NOT NULL CHECK(mode IN('test','live')),
      version integer NOT NULL, slug text NOT NULL, term text NOT NULL CHECK(term IN('monthly','yearly')),
      provider_plan_id text NOT NULL REFERENCES subscription_provider_plans(provider_plan_id),
      provider_id text UNIQUE, status text NOT NULL DEFAULT 'creating',
      payment_method text, authorized boolean NOT NULL DEFAULT false,
      replaces_id uuid REFERENCES billing_subscriptions(id), starts_at timestamptz,
      cancel_at_period_end boolean NOT NULL DEFAULT false, failure_at timestamptz,
      last_synced_at timestamptz, sync_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(version,slug) REFERENCES subscription_plans(version,slug)
    );
    CREATE INDEX billing_subscriptions_reconcile ON billing_subscriptions(last_synced_at NULLS FIRST);
    CREATE UNIQUE INDEX billing_subscriptions_one_replacement ON billing_subscriptions(replaces_id)
      WHERE replaces_id IS NOT NULL AND status NOT IN('cancelled','expired','completed','failed');
    CREATE TABLE subscription_accounts (
      user_id integer PRIMARY KEY REFERENCES users(id),
      current_subscription_id uuid REFERENCES billing_subscriptions(id)
    );
    CREATE TABLE subscription_charges (
      payment_id text PRIMARY KEY, invoice_id text NOT NULL UNIQUE,
      subscription_id uuid NOT NULL REFERENCES billing_subscriptions(id),
      user_id integer NOT NULL REFERENCES users(id),
      amount_paise integer NOT NULL CHECK(amount_paise > 0), tax_paise integer,
      monthly_credits integer NOT NULL CHECK(monthly_credits > 0),
      period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
      paid_at timestamptz NOT NULL, invoice_url text, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK(period_end > period_start), UNIQUE(subscription_id,period_start)
    );
    CREATE TABLE subscription_credit_grants (
      payment_id text NOT NULL REFERENCES subscription_charges(payment_id),
      month_index integer NOT NULL CHECK(month_index BETWEEN 0 AND 11),
      user_id integer NOT NULL REFERENCES users(id), due_at timestamptz NOT NULL,
      credits integer NOT NULL CHECK(credits > 0), granted_at timestamptz, simulated boolean NOT NULL DEFAULT false,
      wallet_transaction_id integer UNIQUE REFERENCES wallet_transactions(id),
      PRIMARY KEY(payment_id,month_index),
      CHECK((granted_at IS NULL AND wallet_transaction_id IS NULL AND NOT simulated)
         OR (granted_at IS NOT NULL AND (wallet_transaction_id IS NOT NULL OR simulated)))
    );
    CREATE INDEX subscription_credit_grants_due ON subscription_credit_grants(due_at) WHERE granted_at IS NULL;
    CREATE TABLE subscription_webhook_events (
      credential_id integer NOT NULL REFERENCES admin_api_credentials(id), event_id text NOT NULL,
      event_type text NOT NULL, body_hash text NOT NULL, provider_subscription_id text,
      received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
      PRIMARY KEY(credential_id,event_id)
    );
    CREATE TABLE subscription_audit (
      id bigserial PRIMARY KEY, admin_id integer REFERENCES admins(id),
      user_id integer REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(db) {
  await db.query(`DROP TABLE IF EXISTS subscription_audit, subscription_webhook_events,
    subscription_credit_grants, subscription_charges, subscription_accounts, billing_subscriptions,
    subscription_provider_plans, subscription_settings, subscription_plans;`);
}
