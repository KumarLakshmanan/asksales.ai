# Local mobile input lifecycle tests

Run from `client`:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium ../node_modules/.bin/playwright test --config=playwright.mobile-input.config.ts
```

Omit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use Playwright's installed Chromium. The suite starts its own Next.js development server on `127.0.0.1:3066`, with a separate `.next-sales-focused-6` build directory. It refuses a different test origin and never reuses an existing server. Next.js may add its generated type directories to `tsconfig.json`; discard those generated entries after the run.

The two projects emulate 390 × 844 and 320 × 568 mobile viewports. Tests also resize to landscape and to a 360-pixel-high viewport. They cover synthetic authenticated Home and conversation screens, keyboard focus, IME confirmation and Shift+Enter, draft retention, standard and prefixed speech APIs, transcript updates, stop/retry, recognition errors, late callbacks and navigation cleanup.

All account and API responses are synthetic. Application WebSocket messages are captured in memory, off-origin HTTP requests are blocked, service workers are disabled, no microphone permission is granted, and speech recognition is replaced before application code executes. Unexpected API mutations and any native microphone acquisition fail the fixture. This is local Chromium emulation with dispatched composition events and mocked recognition, not live authentication, OS keyboard/IME, speech-provider or physical-device validation.

## Regression coverage and integration

The original test-only handoff was commit `b9a584f9195ab7f06301d09e1fc87034f9543230`, based on `1de1a4af9eaee6678fdb00e58cfa9bc33e1e2a42`. The integration lead verified its 29,811-byte plaintext patch against SHA-256 `db83540ecd60d8df26eed08a877b8e003bd07d52f1e355cd868575551ff3c1e1`.

The baseline reproduced six expected failures (three per viewport): conversation Enter during composition, legacy IME keyCode 229, and the multiline composer clipped in a 360-pixel-high viewport. The integrated tests remove those expected-failure annotations and require normal passes. IME coverage also checks Shift+Enter after composition and exactly one send for committed Enter. Agent mention selection has matching unit regressions.

The application guards both message sending and agent mention selection during composition. Short conversation workspaces allow vertical scrolling, and focused composer controls are revealed on focus or viewport resize. Draft contents are preserved. These tests cover the integrated analytics commits `a5f7786` and `af8c053` present in the integration checkout; the original worker could not download those commits.

Machine-readable results are written to `test-results/mobile-input-results.json`. Failure traces, screenshots and attached synthetic state are local test artifacts under `test-results`; the directory is ignored by Git. Shared-branch integration, publication and deployment remain the integration lead's responsibility after this isolated branch is handed off.

Integration validation on 6 November 2026: all 34 browser cases passed with zero skips or expected failures; 26 targeted unit tests passed. Client typecheck passed; targeted lint had zero errors and two warnings on unchanged ChatInterface lines. The 390px short-viewport screenshot was also inspected. Hosted CI and real-device/provider validation remain outside this local evidence.
