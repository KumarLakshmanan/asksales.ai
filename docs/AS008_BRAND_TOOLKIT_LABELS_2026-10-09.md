# AS008 — Brand Toolkit setup control labels

Implemented on `codex/asksales-as008-20261009`, based on fetched and remotely verified `origin/v8` commit `09fe888ec8bdd3fa12ccee0e047cd1d876306222` in `KumarLakshmanan/salesmarketing`.

## Scope

- All five panels in the dashboard's `BrandToolkitForm`: Brand Details, Visual Identity, Voice & Values, Content Settings, and Social Media.
- Visible labels connect to fields using instance-specific React `useId` prefixes and field-specific suffixes. Color picker/hex controls additionally announce their palette, position and purpose.
- Brand Name exposes its native required state. The existing blank-name validation also shows an associated inline error and returns to Brand Details; the imperative save handle retains its validation rejection.
- Existing help text is connected through `aria-describedby`. Token add/remove controls have field-specific names and decorative icons are hidden.
- The token helper is now a module-level component, preserving input/button focus and field IDs through token updates. IDs also remain unique across simultaneous form instances and panel navigation.
- Save payloads, persistence, analysis and uploads are unchanged. AS007 card overflow menus are outside this patch.

## Local verification

The new accessibility regression file was run against the original form before the implementation: **9 tests failed**, reproducing the missing names and required state locally.

Verification uses the existing installed dependencies and supported Node.js 24.19.0. The installed pnpm launcher was version 11 while the repository specifies pnpm 10.30.3; package scripts were run through npm to avoid installation or lockfile changes.

| Check | Result |
| --- | --- |
| Related Vitest suite: `brandToolkitFormAccessibility`, `brandToolkitEnhancements`, `brandToolkitFlowEnhancements`, `brandUploadPreview` | 4 files, 23 tests passed |
| Full client `typecheck` | Passed |
| ESLint on the form and both new regression files | Zero errors; two existing `react-hooks/immutability` warnings about handlers referenced before declaration |
| Client production `build` (Next.js webpack) | Passed |
| New Playwright setup regression in local system Chromium | Desktop 1311 × 841 and mobile 390 × 844 passed; all API writes guarded; zero mutation attempts |
| axe-core 4.13.0 scans of each panel on desktop and mobile | No `label`, `button-name`, `aria-input-field-name`, `aria-toggle-field-name`, `aria-valid-attr-value`, `aria-valid-attr`, `aria-required-attr` or `duplicate-id-aria` violations |
| `git diff --check` | Passed |

Executed package scripts from `client`:

```sh
npm run test -- src/__tests__/brandToolkitFormAccessibility.test.tsx src/__tests__/brandToolkitEnhancements.test.tsx src/__tests__/brandToolkitFlowEnhancements.test.tsx src/__tests__/brandUploadPreview.test.tsx
npm run typecheck
npm run lint -- src/components/BrandToolkitForm.tsx src/__tests__/brandToolkitFormAccessibility.test.tsx e2e/brand-toolkit-accessibility.spec.ts
npm run build
```

The committed Playwright test is `client/e2e/brand-toolkit-accessibility.spec.ts`. This environment used a temporary Playwright configuration with `/usr/bin/chromium` and an isolated Next.js webpack development server on `127.0.0.1:3018`; API traffic was mocked. The extra axe scans used the existing transitive axe-core installation through a temporary runner. No test dependency was added. Local logs and raw axe reports are under `/tmp/as008-*` in this execution environment.

## Limitations

Full axe scans also report issues beyond AS008: color contrast, nested/duplicate main landmarks, and mobile heading order. Some contrast checks were incomplete. These findings remain outside the label repair; this is not a full WCAG conformance claim.

Verification covers local component and browser behavior with mocked data. No live toolkit was created or edited, no logo was uploaded, and no AI analysis was triggered. This branch is not merged or deployed and does not establish that the deployed site is fixed.
