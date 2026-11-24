# Conversation composer and agent browser verification

Implemented and checked against the local QA database on 24 September 2026.

Follow-up: the redundant composer chooser was subsequently removed and replaced
with Manage agents in the campaign header. See
`CAMPAIGN_AGENT_REPLY_POLISH_2026-09-24.md` for the latest controls and reply checks.

## Changes

- Campaign input now has a separate row for Choose agent, labeled Context usage, and Dictate/Stop controls. Mobile labels fit the available width, and the draft resizes when the panel width changes. Attachment and Send remain beside the draft.
- Recording locks only the draft and Send, leaving Stop recording available. Recognition is created on the user gesture, releases the microphone when changing conversations, reports permission/service errors, preserves existing text, accepts a final transcript after Stop, and protects newer edits from late results.
- Context remains visible while loading and offers retry after a load failure. Manual compaction reports success or failure and refreshes the saved summary.
- Team selection has accessible selection buttons and sends canonical backend agent IDs for both individual and team requests.
- Multiple leading mentions, such as `@marcus @sarah`, preserve both selections in autocomplete and routing.
- Read-only team questions now invoke each requested specialist in the same turn. Each receives its own assignment. The existing approval and execution pipeline is preserved, and the handoff is displayed as a question rather than a campaign assignment.

## Browser evidence

Chrome/Playwright exercised the local app at `http://localhost:3000` with the isolated API at port 8080. External customer delivery and background campaign workers were disabled by the QA launcher.

| Check | Result |
| --- | --- |
| Desktop and 390px composer controls | Passed; no horizontal overflow |
| Context panel and manual compaction | Passed; durable summary saved and refreshed |
| Choose Agent and two-agent selection payload | Passed; UI payload test intercepts the hire request |
| Direct Marcus, Sarah, and coordinator messages | Passed against the real local backend and configured model |
| Coordinated Marcus + Sarah question | Passed; separate specialist replies persisted and rendered |
| Existing campaign pipeline preserved | Passed; the saved ICP/content pipeline and index remained unchanged |
| Simulated speech start, transcript, stop, permission error, late final result | Passed |
| Support AI advisory message and saved reply reload | Passed; the agent used its unavailable-information fallback when it could not verify the answer |
| Browser JavaScript errors in the verified flows | None |

The native Chrome speech API was also tested with generated audio and a fake microphone device. Chrome reported `not-allowed`, so native transcription and a physical microphone remain unverified. The application showed its permission error and returned to an editable draft. Browser and macOS microphone access must be allowed for a live microphone check.

No external campaign execution, ad publication, or customer messaging was performed. The hire button payload was intercepted for UI verification; actual specialist routing was separately exercised through read-only messages against the local backend.

## Regression results

- 101 client tests passed across 12 suites covering composer controls, shared primitives, layout, message actions, request identity, draft recovery, activity, and reload behavior.
- 188 server tests passed across 12 suites covering semantic routing, orchestrator state, agent selection, compaction replay, workflow contracts, and Support AI runtime.
- Client and server TypeScript checks passed.
- `git diff --check` passed.

Local browser verification used Next's webpack development mode after Turbopack reported an internal cache error during a restart. No package script or persistent compiler configuration was changed for that workaround.

Detailed local evidence is saved in `.local/campaign-composer-verification.json`, `.local/agent-route-team.json`, and `.local/native-dictation-verification.json`. Composer previews are `.local/composer-desktop-final.png` and `.local/composer-mobile-final.png`.
