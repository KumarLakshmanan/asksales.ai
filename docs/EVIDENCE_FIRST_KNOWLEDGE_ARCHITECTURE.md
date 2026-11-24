# Evidence-First Knowledge Architecture

## Runtime invariant

`KnowledgeGateway` is the only answer-time tenant-knowledge retrieval boundary. Specialists, tools, content generation, outreach, proposals, hotel policy logic, and internal assistants supply a purpose profile and receive a typed `KnowledgeRetrievalResult`. Retrieved content is untrusted data and never shares an instruction lane.

## Context lanes

1. Immutable platform safety and policy instructions.
2. Versioned tenant/persona instructions.
3. Redacted conversation history.
4. Confirmed live-tool and operational facts.
5. Published KB evidence.
6. Authorized reference or attachment evidence.
7. Channel and delivery constraints.

Only lane 5 can produce KB grounding. Transactional facts require successful typed live-tool outcomes. A ticket, attachment, delivery rule, or merely retrieved source cannot mark an answer grounded.

## Ingestion and publication

Every source follows:

`draft → extraction → privacy/integrity scan → structure-aware chunking → lexical/vector indexing → ready_for_review → published`

Failures are explicit: `failed`, `ocr_required`, `quarantined`, or `published_degraded`. New and changed sources are never auto-published. Publication validates authority, effective/expiry dates, privacy classification, injection findings, conflicts/supersession, and both index states. Degraded lexical-only publication is an explicit reviewer choice.

## Retrieval

- Tenant, business profile, audience, purpose, channel, locale, publication, and effective-date filters are applied in SQL.
- PostgreSQL full-text/exact-identifier and model-versioned pgvector candidates run in parallel.
- Reciprocal-rank fusion combines the lists, document diversity removes duplication, and higher-risk ambiguous queries use a bounded reranker.
- Evidence budgets are risk-adaptive: low 4,200 tokens/5 primary chunks, medium 3,200/6, high 4,200/8, and transactional 3,500/6, with an absolute 6,000-token ceiling. Up to four short redacted history turns inform retrieval; the answer model receives at most eight bounded turns.
- Stable evidence IDs carry document, version, chunk, source, authority, freshness, and score metadata.
- Equal-authority conflicts, stale-only evidence, access denial, retrieval failure, and insufficiency are explicit states.

## Answer verification

Generated factual claims cite evidence IDs or confirmed tool outcomes. Replies are deterministically split into atomic sentence/list assertions so a supported paragraph cannot conceal one unsupported bullet. The verifier rejects invented/unauthorized IDs, semantically unrelated citations, conflicts, and unconfirmed transactional claims. Unsupported customer-facing factual answers are replaced with a reason-aware safe handoff; clarification questions remain allowed.

## Privacy and isolation

- Privacy, secret, injection, and integrity scanning occurs before OCR/provider use where applicable and before all embedding or reranking calls.
- External providers receive only stable-token de-identified search representations.
- Original source data remains separate from display/search chunks.
- Documents, versions, chunks, embeddings, retrieval audits, and governance audits use PostgreSQL `FORCE ROW LEVEL SECURITY` with transaction-scoped tenant context.
- Retrieval diagnostics store a redacted fingerprint, filters, selected IDs, timings, and status—not raw customer queries.
- Expired diagnostics are swept by `pnpm --dir server knowledge:maintenance`.

## Operations

- `knowledge:v2:prepare`: read-only reconciliation snapshot.
- `knowledge:v2:cutover`: maintenance mode, full migration, selective publication/quarantine, reconciliation, atomic enablement.
- `knowledge:v2:rollback`: restore the legacy read path.
- `knowledge:maintenance`: repair missing active-model embeddings, recover indexable failures to human review, classify superseded historical failures, keep privacy/integrity quarantines closed, report action-required/stale/review-due sources, and remove expired retrieval audits. The same operation runs daily through the durable worker queue.
- `knowledge:architecture:audit`: fail CI on specialist bypasses, legacy retrieval calls, raw table reads, or public raw embedding routes.
- `test:knowledge:acceptance`: privacy, poisoning, chunk-boundary, end-of-document, identifier, fingerprint, and claim-verification acceptance tests.
