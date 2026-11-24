# Occupancy handoff and graph editor release — 19 September 2026

## Verified cause

Conversation 461, run 146, received `0` for the published children-count question. Worker logs show OpenRouter returned HTTP 429 while verifying available credits. Intent classification failed before the playbook collector ran, causing handoff 273. This does not establish that the account had no balance.

## Fix

- Recognize exact integer answers only for an allowlist of non-PII occupancy fields in an active, tenant-owned, immutable published playbook. Validate the current missing field's bounds before deterministic classification.
- Preserve zero, human ownership, tenant escalation rules, safety checks, privacy checks, and normal classification for mixed or unrecognized text. Audit the matched run, node, field and count.
- Expose the retained graph editor as a first-class Graph tab. Keep the guided conversation editor and existing graph functionality intact.

## Verification before release

- Server regression: 53 suites / 704 tests passed; 8 suites / 97 tests skipped.
- Focused client tests: 27 passed; client TypeScript and scoped lint passed.
- Desktop and mobile graph editing E2E: 2 passed, including selecting/editing a node, saving, preserving connections and field data, and overflow checks.
- API bundle built. Server scoped lint passed (test mock warning types subsequently tightened).
- Full server TypeScript remains blocked by existing unrelated errors in content calendar, lead execution, AI visibility and older tests; no changed runtime-file errors appeared.
- Synthetic production dry-run against the current published playbook: `0` accepted as zero children, `1` accepted as room count, and `No preference` returned verified room availability. Customer side effects were suppressed; no customer message was sent.
- Graph validation reported no errors in the inspected owned drafts/published versions. This verifies structural validity, not an exhaustive execution of every possible branch.

## Approved recovery

The user approved restoring the existing inbound `0` and resuming AI without sending a message. Recovery must run after deployment and abort if a human has claimed/replied, the latest message changed, or the stored run/ownership no longer matches. Preserve message history and record recovery provenance. Deployment and recovery receipts will be appended after verification.

The frontend-design and testing skills guided the explicit graph entry point and desktop/mobile regression coverage. The deployment skill's unavailable Replit-specific tools were replaced with the project's established deployment, backup and health-check workflow.

## Deployment and recovery receipt

- Runtime release `fb0e6369e` deployed successfully. An SSH interruption during the client build was recovered by checking the build lock/processes and rerunning the established deployment using the completed cache. No concurrent build was started.
- Verified backup: `/var/backups/asksales/predeploy-20260919T103007Z.dump`. All 270 migrations already applied; none pending. API, client and Hermes returned HTTP 200. Previous runtime images retain rollback tags; routine unused build cache/dangling-image cleanup ran.
- Post-deployment synthetic replay passed all three steps again with customer side effects suppressed.
- Current Hotel Sales Agent playbooks 21, 72, 73 and 74: drafts and published versions all passed structural validation. Hospitality playbook 21 has 56 steps and 81 connections.
- Live Chrome verification on Oro Circle: Graph tab, full flow, selectable nodes, editable step properties and branch-condition inspector work. No live playbook content was saved or published during this verification.
- At `2026-09-19T10:33:14.000Z`, guarded recovery restored `stay.children=0` from message 3982, resolved handoff 273 and linked ticket 276, and set conversation 461 to `ai_active`. All ownership/message guards passed. Rooms remain missing; next customer input can continue the existing run. Latest message remained 3983; zero messages were sent by recovery.
- A final diagnostic-script null guard was added after runtime deployment; this is only a manually invoked diagnostic, not application runtime. Its rebuilt bundle was used for the successful post-deployment replay. Full server type-check output now contains no errors in any changed file; unrelated baseline errors remain.
