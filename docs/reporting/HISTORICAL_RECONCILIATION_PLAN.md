# Reporting history reconciliation: dry-run plan

Base audit: `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`. This document is a plan, not an executed migration/backfill. No production/provider reads or writes were performed for this implementation.

## Release order

1. Integrate the Reporting patch against the reviewed base and resolve shared-file changes with the other owners. Preserve their source semantics and tests.
2. Apply the **new** migration `370_reporting_metric_precision.js` using the existing custom migration runner in an authorized staging rollout. Reporting owns IDs 370–379; Data owns 330–331 and Tenant owns 340–349. Do not rename any applied migration. Dependency: `performance_metrics.ctr` must exist (baseline migration 001); migration 270's fractional conversion columns must already be present for the current application. There is no functional dependency on a particular new Data/Tenant migration, but the combined runner must order all earlier files before 370.
3. Widen CTR **before** deploying the new ingestion implementation. Widening is backward compatible. The migration changes no rows or permissions. Its rollback deliberately relies on PostgreSQL's atomic rejection if high CTR values cannot fit the old type; it never clamps/deletes facts.
4. Deploying future-write prevention does **not** certify or repair old Meta rows or rounded campaign caches. Review history separately before accepting affected historical totals as reconciled.

## Read-only candidate discovery (not executed here)

Run only against an approved sanitized/staging snapshot first. This query reports metadata, not customer names, message content or credentials:

```sql
SELECT campaign_id, platform, MIN(date) AS first_day, MAX(date) AS last_day,
       COUNT(*) AS candidate_rows
FROM performance_metrics
WHERE platform = 'meta' AND hour IS NULL
  AND platform_data #>> '{source,dateStart}' IS NOT NULL
  AND platform_data #>> '{source,dateStop}' IS NOT NULL
  AND platform_data #>> '{source,dateStart}' <> platform_data #>> '{source,dateStop}'
GROUP BY campaign_id, platform
ORDER BY campaign_id;
```

Those rows have evidence of the former range-total/daily-date mismatch. A row without these markers is **unknown**, not proven clean. Also inventory failed sync windows/high CTR errors and the dates/campaigns with lost conversion-value or rounded conversion evidence. Do not infer lost source precision or revenue from the rounded cache.

## Dry-run reconciliation bundle

For each explicitly approved campaign/platform/account/currency and reporting window, collect an immutable snapshot from an approved existing export or mock provider. Live provider access is a separate authorization; no automatic provider fetch is supplied by this patch.

Record: source snapshot hash, provider/account identity, account timezone, UTC reporting date convention, selected action family/window, retrieval time, complete-page evidence, source row count and coverage bounds. Pin the application/reconciliation version. Do not attach bearer tokens or raw credential-bearing URLs.

Produce a read-only diff with:

- Original stored daily key/value and provenance hash; authoritative provider daily key/value and provenance hash.
- Exact duplicate and conflicting-ID counts; conflicting source-day facts block reconciliation rather than choosing an arbitrary latest value.
- Separate counts, spend, conversion values and fractional conversions per currency. Never sum or convert currencies implicitly.
- Weighted rates recomputed from source numerators/denominators; daily reach explicitly labelled as summed daily reach.
- Proposed removal/replacement keys limited to **proven contaminated rows in the approved source coverage**, proposed daily upserts and resulting campaign cached totals. This is a proposal only; do not run delete/update SQL from this document.
- Before/after campaign, child and day totals with discrepancies and documented provider aggregation limitations. Missing source coverage is not a zero-activity day.

## Gates before any historical write

An owner must approve the exact campaign/account/date selection, provider correction window, handling of unknown historical provenance and required monetary/attribution semantics. Review the dry-run diff and independent reconciliation totals. Take a recoverable snapshot of every affected fact/cache key. Verify that concurrent polling cannot race the repair and that automation does not use suspect values to authorize actions; changing live controls is an operational decision outside this patch.

In an authorized future repair, use a transaction/locking strategy consistent with business scoping and provider identity, and compare the original row/provenance hashes before committing. Abort on drift, conflicting source data, partial provider pages, missing currencies or any unexplained reconciliation difference. Rebuild caches from reconciled daily rows, not old totals. Avoid global deletion, row splitting/distribution of range totals, broad resets or silent default-currency conversions.

## Post-repair acceptance

Repeat replay/overlap/correction fixtures against the repaired snapshot; compare UI/API/export totals to source facts for the same filters. Verify high/fractional CTR/conversions, 7/30/90-day windows, future-row exclusion, account/platform/currency filters, correct child grain and independent pagination. Preserve the approved diff and outcome for rollback/audit. A code deployment alone does not satisfy these historical-data gates.

## Decisions intentionally not invented

- Weekly conversion clock and whether repeat won transitions count; current home conversion-history calculation still uses lead update time and needs an authoritative lifecycle event contract from CRM.
- Longer automatic reconciliation horizons for paused/ended campaigns and provider-specific attribution windows.
- Custom CRM stage/type mappings, booking status/payment/refund recognition, missing-price semantics and allocation of one lead's lifetime outcomes among multiple campaign touches.
- Default-zero versus explicitly scored lead/ICP values. Numeric zero is included and existing nonzero ICP fallback retained; a provenance/nullable-score contract is still needed to distinguish unscored defaults.
- Activation/idempotency contract for the unused pixel-ingest queue; date-scoped conversational queries and comparable campaign-ranking definitions.
