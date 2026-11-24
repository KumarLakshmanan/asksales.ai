# Campaign agent controls and reply attribution

## Changes

- Removed the redundant Choose agent action from the campaign composer. Context, attachments, dictation and sending remain available. The placeholder distinguishes addressing an agent with an @mention from selecting the campaign team.
- Added Manage agents to the campaign header. It opens the existing Choose Agent side tab, including the Results pane on mobile, without sending or changing a draft. Existing chat recommendation cards still select agents.
- Added a common specialist reply instruction: answer directly because the message title already identifies the speaker. Coordinated questions explicitly assign each specialist only their own answer.
- Before streaming or saving a specialist response, remove a redundant leading speaker label. For coordinated questions with explicit speaker sections, keep the responding specialist's section.
- Correct the display of older duplicated team replies only when the same user turn explicitly addresses multiple agents, every addressed specialist has replied, and every reply contains exactly those speaker sections. The database history is not rewritten. Standalone combined answers, coordinator summaries, ordinary name mentions, quotations, code, tables and draft introductions remain intact.

## Verification

- 53 client tests passed across reply presentation, composer controls, input behavior and conversation presentation.
- 62 server tests passed across response grounding, orchestrator routing, memory/approval handling and response identity.
- Client and server TypeScript checks passed; `git diff --check` passed.
- Local Chrome verified the header chooser, preserved draft, composer controls, the exact historical replies shown in the screenshot, reload behavior and mobile navigation at 390px without horizontal overflow.
- A fresh read-only team request in the isolated local QA campaign produced two separate persisted replies: Marcus returned the boutique-hotel criterion, and Sarah returned CTR. Neither reply had a speaker prefix or the other specialist's answer. Both rendered without JavaScript errors. The saved campaign pipeline remained unchanged.
- New read-only transition metadata persisted correctly as `readOnlyHandoff: true`.
- Support AI's composer and response-channel selector loaded successfully. An initial browser navigation timed out during local Next.js compilation; the completed retry passed with no browser JavaScript errors.

## Local evidence

- `.local/agent-reply-polish-verification.json`
- `.local/agent-route-team.json`
- `.local/agent-replies-corrected-desktop.png`
- `.local/agent-replies-corrected-mobile.png`
- `.local/composer-without-chooser-desktop.png`
- `.local/composer-without-chooser-mobile.png`

Checks used the isolated local snapshot and read-only campaign advice. No campaign execution, customer delivery or deployment was performed. Native microphone transcription retains the previously documented browser/macOS permission limitation; this change does not alter the dictation implementation.

## Commit snapshot check

The scoped commit was additionally checked from an isolated export of its staged
files: 68 client tests and 186 server tests passed, and client TypeScript passed.
Server TypeScript reported the existing six-argument `sendDirectMessage` call in
`server/services/instagramMessageRouter.ts:269`, whose current signature accepts
two or three arguments. That file is outside this conversation commit; its
separate pending integration update is preserved in the working tree. The earlier
successful server type check above used the complete local working tree.
