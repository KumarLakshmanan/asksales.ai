# Campaign conversation race and fallback fixes

Date: 2026-09-23

Scope: the three additional issues identified in the campaign-conversation audit. All three are fixed in the local working tree. This report does not claim deployment or full provider end-to-end verification.

## 1. Delayed HTTP replies crossing campaign boundaries

**Original reproduction:** Start a message in campaign A with WebSocket delivery queued, switch to B before the HTTP fallback completes, then resolve A's response. A's user/assistant messages appeared in B and B's processing indicator was cleared. An isolated execution of the original callback reproduced this.

**Cause:** The fallback updated shared conversation state without verifying the original campaign or turn. Its error path also appended errors and returned a draft-restoration result after navigation.

**Fix:** `client/src/hooks/useChat.ts` associates each send with a turn token and campaign. Success, failure, message reconciliation, and the safety timer check ownership. Navigation invalidates old turns, unmount cleans up, and legitimate new-campaign adoption through realtime receipts remains supported.

**Regression results: PASS**

- Late success and failure from A cannot append to B, restore A's draft, or stop B's processing/timer.
- A newer turn in the same campaign supersedes an older fallback.
- Navigating away and back does not revive the old turn.
- A new campaign cannot steal navigation after switching elsewhere or unmounting.
- HTTP-only new-thread adoption and realtime-before-HTTP adoption still work.
- Existing WebSocket/HTTP receipt reconciliation still avoids duplicate messages.

Tests: `client/src/__tests__/useChat.test.tsx` (real hook, deferred mocked transport, fake timers).

## 2. Selected business profile lost in fallback

**Original reproduction:** Choose a non-default business for a new campaign while realtime delivery is unavailable. The WebSocket envelope included its ID, but the HTTP payload omitted it and the HTTP handler passed `undefined` to the core processor.

**Cause:** The two transports assembled different payloads, and the handler omitted the business-profile argument.

**Fix:** Both transports now share a request payload. `server/mastra/chatController.ts` forwards `businessProfileId` through the existing core validation and ownership checks.

**Regression results: PASS**

- HTTP and WebSocket payloads preserve the same selected business and attachment references.
- Route validation preserves the profile ID; the real HTTP handler/core create the thread with that profile, not the default.
- Omitted profile IDs retain default-business behavior.
- Invalid IDs return 400; missing or another user's profiles return 404 without creating a thread or silently falling back.

Tests: `useChat.test.tsx` and `server/tests/chatHttpBusinessProfile.test.ts`. Server persistence, credits, model routing, and events are mocked; no real database records or model calls are created by these tests.

## 3. Duplicate pending team-hire submissions

**Original reproduction:** Invoke “Hire Team & Start Workflow” twice before the first request completes. An isolated execution of the original callback submitted two requests. Duplicate downstream execution was not asserted.

**Cause:** Unlike individual hiring, team hiring lacked an immediate in-flight guard and a disabled pending state.

**Fix:** `AgentChooseTab.tsx` uses a synchronous ref guard plus a disabled, busy “Assembling Team…” button. Selection changes and individual hires are blocked while team submission is pending. Failure preserves the selection and unlocks an explicit retry; success clears it. A missing execution callback disables submission.

**Regression results: PASS**

- Two clicks in one render batch submit exactly once.
- The pending button is disabled and exposes its busy state.
- Team selection cannot change during submission.
- Success clears selection; failure preserves it and permits a subsequent explicit retry.
- No callback means no enabled execution button.

Tests: `client/src/__tests__/agentChooseTab.test.tsx` (rendered component with mocked execution).

## Verification summary

- Client: **142 tests passed across 13 files** — `useChat`, `agentChooseTab`, `agentChooserNavigation`, `chatInputArea`, `conversationSurfacePolish`, `conversationDraftRecovery`, `conversationRunStatus`, `conversationThreadLoadRecovery`, `conversationTabReloadContract`, `conversationVisualPane`, `conversationOverflowContract`, `conversationStreamReducer`, `conversationActionResolution`.
- Server: **42 tests passed across 5 files** — `chatHttpBusinessProfile`, `icpContinuation`, `agentSelection`, `chatActionResolutionContracts`, `conversationApprovalContract`.
- Client and server `pnpm typecheck`: **PASS**.
- `git diff --check`: **PASS**.

The testing skill's side-effect-safe verification guidance informed these checks. Its browser-test runner was unavailable, so this fix pass used the existing test frameworks, rendered-component tests, and mocked network/processing boundaries. No new Chrome end-to-end outage test, actual team workflow, outreach delivery, publishing, or paid execution was performed. No deployment or commit was performed in this fix pass.
