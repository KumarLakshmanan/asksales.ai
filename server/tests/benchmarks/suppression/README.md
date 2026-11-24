# Salesmarketing suppression query benchmarks

This fixture measures the actual `getSuppressedRecipients` query under local business RLS. It compares three proposals without editing the shared service or applying application migrations beyond a disposable synthetic schema. The measurements identify both gains and regressions; none of the proposals is ready for an unconditional rollout.

The work starts exactly at `1de1a4af9eaee6678fdb00e58cfa9bc33e1e2a42` on local branch `codex/sales-focused-3`. No older audit base was used. Integration commits `a5f778646874f7fd24ff927e379f1368fc84c8c7` and `af8c0532802d3f30211a0adfdc746a0dde709a43` were unavailable and were neither recreated nor validated.

## Findings

Email execution times below are ranges of the two trial medians, in milliseconds. Each median contains three `EXPLAIN ANALYZE BUFFERS` samples after one discarded warmup. SMS and WhatsApp measurements are in the JSON evidence as controls.

| Distribution and addresses | Current query | Proposed expression index | Proposed materialized receipts | Proposed union |
| --- | ---: | ---: | ---: | ---: |
| Sparse, 1 | 0.904–1.025 | 0.834–0.919 | 0.890–0.892 | 1.186–1.193 |
| Sparse, 50 | 1.580–1.588 | 1.529–1.688 | 1.637–1.747 | 1.127–1.231 |
| Sparse, 200 | 20.581–20.927 | 20.889–21.356 | 1.124–1.196 | 1.232–1.239 |
| Receipt heavy, 1 | 13.394–14.223 | 13.367–13.928 | 15.312–16.314 | 19.772–21.032 |
| Receipt heavy, 50 | 17.489–622.599 | 615.480–639.307 | 46.820–47.983 | 19.646–21.186 |
| Receipt heavy, 200 | 16.216–16.624 | 17.050–17.338 | 18.780–18.909 | 20.693–22.033 |
| Dense leads, 1 | 3.234–3.463 | 3.202–3.814 | 3.329–3.675 | 4.547–4.727 |
| Dense leads, 50 | 9.820–10.392 | 9.633–10.147 | 10.397–11.306 | 4.600–4.739 |
| Dense leads, 200 | 23.170–23.832 | 24.118–25.347 | 3.652–3.903 | 4.927–5.088 |

The current receipt-heavy 50-address query changed plan between independently seeded/analyzed trials. Trial 1 performed 49 receipt index scans, averaging 14,350 rows rejected by the filter per loop and recording 164,789 shared buffer hits. Trial 2 used one bitmap heap scan of 15,004 receipt rows and 599 shared hits. These are warm-cache local measurements, so a single timing or universal improvement percentage would be misleading.

The proposed expression index still had only `user_id = 991` as its index condition; normalized destination equality remained a filter. It selected 49 correlated scans in both recorded trials and added 892,928 bytes for the receipt-heavy fixture. Do not promote this index based only on its expression matching the query.

Materializing receipts once and using a single union existence check each reduced the sparse 200-address query substantially. The recorded base plan spent about 18.5 ms compiling JIT expressions, while both proposals avoided JIT in that case. Both proposals were slower for a single receipt-heavy miss and the receipt-heavy 200-address case. Materialization also regressed the faster receipt-heavy 50-address plan. The union proposal avoided that case's worst plan but still increased its faster trial's latency. All returned suppression sets and tested RLS boundaries remained equal.

## Fixture and isolation

Each trial seeds 30,000 generated leads and 30,000 generated receipts, plus six boundary rows in each table. The distributions use blacklisted lead intervals of 1,000 / 1,000 / 10 and failed receipt intervals of 100 / 2 / 100. Email-only opt-outs occur every 100 generated leads. Generated receipts include mixed provider channels, whitespace, case variations and legacy `lead_name` fallback addresses.

The independent correctness checks cover retired opt-outs, duplicate destinations, SMS country-code normalization, distinct WhatsApp aliases, email-only unsubscribe, bounce/complaint/delivery-status evidence and cross-business access. The timed email singleton is a miss; larger email chunks contain four suppressed destinations and otherwise misses.

Execution requires both `OUTREACH_SUPPRESSION_BENCHMARK=1` and an explicit PostgreSQL URL whose host is `localhost` or `127.0.0.1` and whose database is exactly `implementation_synthetic`. URL query parameters are rejected because they could override the checked host or database. Each fixture owns a random schema, uses the existing local business RLS helper and drops only that schema on completion. Runtime queries use the non-login, non-bypass local business role. The ordinary PostgreSQL QA opt-in does not enable this benchmark.

Only the relevant real migrations (350 and 584), supporting receipt indexes, columns used by the query and the existing emulated business RLS helper are loaded. This is actual PostgreSQL with synthetic data and a reduced schema, not production schema/data validation. No providers or customers are contacted. `ANALYZE` covers the company table as well as leads and receipts; missing company statistics distorted early exploratory plans and are excluded from the recorded evidence.

Recorded runtime: PostgreSQL 16.15, x86_64, JIT on, 128 MB shared buffers, 4 MB work memory, Node v24.22.1. The final timed run did not overlap typechecking or other database tests. Variant order is fixed, and caches are warm; this is a reproducible diagnostic rather than a statistically randomized capacity test. The JSON records the shared service source SHA-256.

## Run locally

Use a disposable local PostgreSQL instance. For example, with Docker:

```sh
docker run --rm -d --name sales-suppression-bench \
  -p 127.0.0.1:55463:5432 \
  -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD=fixture \
  -e POSTGRES_DB=implementation_synthetic \
  postgres@sha256:5264710be20f409750ac6dc4e5706dcef929c87e241605463f0f9aefa932a8d9
```

Wait for `docker exec sales-suppression-bench pg_isready -U fixture` to succeed. With the repository dependencies installed, run from `server/`:

```sh
OUTREACH_SUPPRESSION_BENCHMARK=1 \
OUTREACH_QA_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:55463/implementation_synthetic \
npm run test -- --runInBand tests/outreachSuppressionBenchmarkPostgres.test.ts
```

This runs 216 combinations: three distributions, two independently seeded/analyzed trials, four variants, three channels and three audience sizes (1, 50 and 200). Full plans, SQL and synthetic parameters are written to `server/.local/suppression-benchmark/latest.json`. Set `OUTREACH_SUPPRESSION_BENCHMARK_OUTPUT` to select another artifact path. Stop the disposable instance with `docker stop sales-suppression-bench`.

The default test invocation makes no database connection: the 11 URL/query guard checks run and the six benchmark trials are skipped.

## Evidence and proposed patches

- `evidence/2026-11-06-summary.json`: all 216 measurements, sample times, JIT time and receipt scan summaries.
- `evidence/2026-11-06-email-plans.json`: full plans for both trials of the receipt-heavy 50-address case and sparse 200-address case, for every variant.
- `proposals/receipt-normalization-index.sql`: an experimental index applied only inside the fixture schema.
- `proposals/materialized-receipts.patch` and `proposals/union-receipts.patch`: alternative service patches for integration review. Neither patch was applied. They each pass `git apply --check` at the exact base, and the benchmark measures their intended SQL shapes through guarded transformations of the real service SQL. Apply and validate each separately before claiming the service patch itself is tested.

Review production-representative distributions and plans before selecting a query shape. Preserve suppression and business isolation semantics; the benchmark does not justify changing RLS or access policy. An integration owner must reserve any migration number and assess index write/storage costs if pursuing the index proposal.

## Validation and handoff

- Final opt-in benchmark: 17 tests passed; all 216 comparisons completed.
- Existing suppression performance and recipient review suites: 16 tests passed after the fixture assertion correction.
- The existing WhatsApp performance assertion previously capped the materialized CTE at three rows. The real query projects two aliases for each of two blocked leads, including empty aliases, so its correct upper bound is four. Only that fixture expectation changed; service behavior did not.
- Targeted new-file ESLint and server typecheck passed.
- Both proposal patches pass dry application checks; no proposal was applied to the shared service or migration directory.
- The first `pnpm` launcher attempted an implicit dependency installation with an unavailable home store. Validation used `npm run` against the already installed dependencies. No dependency or lockfile changes were made.

The full application suite, production PostgreSQL plans, provider delivery and the two unavailable integration commits were not validated. No push, merge, deployment or GitHub Actions access was attempted; shared-branch publication belongs to the integration lead.
