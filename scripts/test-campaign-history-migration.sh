#!/usr/bin/env bash
set -euo pipefail

pg_bin=$(pg_config --bindir)
pg_dir=$(mktemp -d)
cleanup() {
  "$pg_bin/pg_ctl" -D "$pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf -- "$pg_dir"
}
trap cleanup EXIT

port=55487
"$pg_bin/initdb" -D "$pg_dir/data" -U campaign_history_qa --auth=trust --locale=C >/dev/null
"$pg_bin/pg_ctl" -D "$pg_dir/data" -l "$pg_dir/log" \
  -o "-h 127.0.0.1 -p $port -k $pg_dir -c shared_buffers=32MB" -w start >/dev/null
"$pg_bin/createdb" -h "$pg_dir" -p "$port" -U campaign_history_qa campaign_history_qa

CAMPAIGN_HISTORY_QA_DATABASE_URL="postgresql://campaign_history_qa@127.0.0.1:$port/campaign_history_qa" \
  NODE_OPTIONS=--experimental-vm-modules \
  pnpm --dir server exec jest --runInBand --runTestsByPath tests/campaignHistoryPostgres.test.ts

# WhatsApp platform billing: migrations 595/596/599 and the service SQL.
"$pg_bin/createdb" -h "$pg_dir" -p "$port" -U campaign_history_qa whatsapp_billing_qa
WHATSAPP_BILLING_QA_DATABASE_URL="postgresql://campaign_history_qa@127.0.0.1:$port/whatsapp_billing_qa" \
  NODE_OPTIONS=--experimental-vm-modules \
  pnpm --dir server exec jest --runInBand --runTestsByPath tests/whatsappBillingPostgres.test.ts
