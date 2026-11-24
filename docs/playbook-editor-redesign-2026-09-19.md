# Playbook editor redesign — 19 September 2026

## Scope

Redesigned the member playbook page at `/dashboard/settings/outreach/playbooks` (and its shared support surface) for everyday editing. No backend schema, published playbook graph, routing assignment, privacy policy, or customer conversation was changed by this UI release.

## Changes

- Searchable playbook list with accurate Live, Paused, Draft, and Archived states.
- Four focused sections: Conversation, Questions, Channels, and Settings.
- Guided step list by default; the complete flow map, node types, branch conditions, and connection controls remain available.
- One question at a time, with search and human-readable labels. Choice aliases, identifiers, privacy, CRM mappings, and developer shorthand remain under advanced disclosure controls.
- Selected collection steps show their actual questions in configured order; the full field-selection list is collapsed until needed.
- Draft save, validation, publication, safe testing, template installation/reset, archive/restore, and routing controls retained.
- Publication confirmation, unsaved-change guard, invalid-JSON guard, and immediate-effect routing notices.
- Existing design tokens, moderate type weights, light/dark themes, and responsive layouts; no new fonts or dependencies.

## Signed-in account review

Reviewed Oro Circle in the user's signed-in Chrome account. It had four current playbooks and two archived playbooks. Hospitality Sales & Enquiries was Live at published version 12 and managed template version 12; the three proposal templates were Paused. The hospitality playbook had ten enabled all-channel intent assignments and passed server validation.

Account-specific edits to a managed template disable automatic template updates. Pending an explicit user choice, preserve the managed playbook, published version, paused/archived states, and routing. Suggested future wording changes are a clearer name-entry instruction and a neutral alternative-stay question that does not independently assert unavailability.

## Verification

- Five focused unit suites: 27 tests passed.
- Desktop Chromium (1440px) and mobile Chromium (390px): 2 end-to-end tests passed using an isolated 44-question fixture and mocked APIs; no customer messages or live account changes.
- End-to-end coverage: question search/edit/save, graph and metadata preservation, guided steps and flow map, unsaved-switch cancellation, malformed JSON, blocked publication after failed validation, immediate routing controls, light/dark themes, and horizontal overflow.
- Scoped ESLint and the final TypeScript no-emit check passed.
- Full client suite: 172 suites / 1,265 tests passed; two unrelated source-contract tests failed in `platformAccessRecovery.test.ts` and `adPerformanceUiContract.test.ts`. Their referenced application files were not changed by this work.

## Release

- Source release: `3c7b39fab`, committed and pushed to `origin/v7`, deployed successfully with `deploy.sh`.
- Verified database backup: `/var/backups/asksales/predeploy-20260919T043638Z.dump`; rollback service images retained by the established deployment workflow.
- Production compilation and TypeScript checks passed; all 262 pages generated. All 268 migrations already applied; no migrations were needed.
- Deployment health checks: API HTTP 200, client HTTP 200; API, client, and Hermes containers healthy. The existing deployment workflow also ran its standard CRM identity reconciliation (394 candidates, 392 reconciled, 2 skipped).
- Live Chrome verification in Oro Circle: the new editor loads; question search selects the check-in question with its original Date answer format; guided Stay details shows questions in configured order; the full flow map remains reachable; Settings still shows managed template version 12; all ten enabled routing assignments retain priority 40 and 100% eligible traffic.
- Live account counts verified exactly after deployment: four current playbooks, two archived, and a published hospitality flow containing 56 steps and 43 questions. The separate automated fixture intentionally contains 44 questions.
- No horizontal overflow at the user's desktop viewport; no captured browser console errors during the post-deployment checks; draft remained saved and server checks passed. The Questions view was left open in the user's Chrome session.
- No account-specific playbook wording, published version, routing, privacy settings, or paused states were changed. Automatic managed-template updates remain enabled.
