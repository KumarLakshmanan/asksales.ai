# Support natural replies — 22 September 2026

## Report and cause

The Oro Circle location answer exposed “From the published knowledge base:” in one WhatsApp bubble and the selected fact in another. The low-risk playbook FAQ recovery path replaced generated answers with a source quotation and an internal heading. Delivery then split the double newline into separate messages.

## Changed behavior

- Customer-facing, low-risk knowledge recovery now uses the configured AI provider to write a concise reply from selected, approved facts only.
- Existing claim validation and a separate semantic AI review must both accept the rewrite. Source access/publication is rechecked after generation.
- Rejected or unavailable generation falls back to the exact selected source text without the internal heading. Internal previews retain provenance.
- Short verified knowledge replies stay in one message; explicit message separators and published choices keep their existing behavior.
- Shared specialist-agent guidance requests direct, natural wording without overriding exact playbook prompts, consent or factual safeguards.
- Verified paraphrases cannot be blindly truncated, because that could remove important conditions.

For the supplied airport fact, a permitted response is: “We’re about 30 minutes from Kempegowda International Airport.” No street address, map URL or travel mode is inferred.

No regex-based customer-intent routing was added. Output-format and factual safety checks remain deterministic where appropriate.

## Local verification

- Support/knowledge/routing regression selection: 77 suites passed; 1,111 tests passed; 9 suites and 130 tests skipped. Skipped tests are not certified by this run.
- Server TypeScript check passed.
- API and worker builds passed.
- Added coverage for the reported location question, failed semantic review, unsupported details, omitted qualifications, source withdrawal during generation, model outages, response-length safeguards, one-bubble WhatsApp delivery and duplicate-delivery protection.

The tests use mocked model responses and mocked WhatsApp delivery. They verify control flow and safeguards, not live provider quality or production delivery. The local runtime emitted an engine-version warning (Node 20.11.1 versus the declared Node 24.18.1 requirement).

## Remaining release checks

This change has not been deployed or verified in live WhatsApp. After the coordinated release, ask the Oro Circle bot “where is this located ?” and confirm one direct, grounded reply without internal headings. Also check a multi-option answer with pricing conditions and a provider-failure fallback.

Translation remains subject to the existing conservative claim verifier. A translation it cannot verify falls back to the source wording; multilingual natural-generation success is not claimed.
