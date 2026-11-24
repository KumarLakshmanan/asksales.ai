# Admin usage measurement availability

The LLM and Gemini admin usage endpoints distinguish recorded zero measurements
from missing measurements. Request counts still count all recorded requests.
No historical records, prices, exchange rates or billing rules are changed.

## Response contract

- `totalTokens` and `totalCostCents` (and dollar `totalCost`) are null if any
  request in that population lacks the corresponding measurement. Complete empty
  populations and explicitly stored zeros retain zero totals.
- `measuredTokenCalls` and `measuredCostCalls` expose the number of measured
  requests. Model, purpose, thread and day groupings preserve this coverage too.
- `totalDurationMs` sums recorded durations and `measuredDurationCount` counts
  them, including measured zero. `avgLatency` / `avgDurationMs` divide by measured
  durations, not total requests. No measured duration means null average.
- Gemini's current table has no duration column. Its latency remains null with
  zero duration coverage; historical latency is not reconstructed.
- Raw records retain their stored values. Missing recent-activity measurements
  remain null. Existing stored zeros are treated as recorded zeros; this does not
  establish how an older producer obtained them.

The combined provider page combines duration sums/counts only when the response
supplies coverage, and labels the measured request population. For example,
one measured request at 100ms and three at 300ms produce 250ms. Unknown coverage
is not inferred from request counts or an old average. Token and cost totals
remain unavailable if a successful source reports missing measurements. Existing
partial-provider request warnings continue to identify incomplete populations.
The individual provider pages render nullable measurements safely as well.

Credit analytics tracks failed sections independently. Failed summaries, daily
activity, provider reports and top-user reports show unavailable states, including
after a previously successful refresh. Daily zero filling occurs only for a
successful daily request. Superseded requests cannot replace newer responses.
Admin Home renders omitted or invalid counts and omitted health as unavailable;
valid zero counts and the reported health text are preserved.

## Validation and evidence boundary

The read-only review evidence was verified against SHA-256
`7dd49750c2de68ce8154b5b20d42c64493b441a5c5b514b5dc9586f235514f68`.
Its five failing assertions were reproduced before implementation. The imported
harnesses were strengthened with explicit null/coverage assertions, recorded-zero
controls, individual provider pages and refresh failures. The weighted latency
fixture supplies measured duration counts/sums; actual Gemini history has none.

Local checks: 316 server tests passed across 18 suites with zero skips, including
disposable PostgreSQL 18.6 isolation/concurrency and a synthetic HTTP/browser
usage check. Fifty client tests passed across eight suites. Targeted lint and
both typechecks passed. This is synthetic/local validation, not production
financial reconciliation, live-provider validation, hosted CI or release approval.
