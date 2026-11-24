# AskSales in-application documentation

The authenticated routes are `/dashboard/documentation` and
`/dashboard/documentation/:topic`. They use the existing main dashboard layout:
approval, setup, subscription, platform maintenance and workspace verification
are unchanged. This is user documentation; private deployment procedures,
credentials, administrator control-plane instructions and customer data do not
belong in its content. Generic guide text does not grant module access.

## Maintain content

Edit the typed topic data in `client/src/content/documentation`. Each topic has
prerequisites, ordered workflow instructions, outcomes/troubleshooting,
destination links and maintainer-only source evidence. Keep evidence aligned
with actual code, including limitations and configuration-dependent behavior.
The deployed page does not display the evidence file paths. Search runs locally
and is not persisted or submitted to an API.

Contextual links use `client/src/lib/documentation-navigation.ts`. The dashboard
header links to the current topic at desktop widths; the account menu provides
the same contextual destination on mobile. The sidebar and page finder expose
the documentation index. Operational notices retain essential status/errors and
actions, linking to the exact guide section for extended explanation.
Unknown topic paths show an in-app recovery view. The dashboard's existing
class error boundary consumes Next's `notFound()` signal, so this route avoids
throwing it or turning an outdated help link into an unexpected-error screen.
The recovery view inherits authentication and returns the normal streamed shell;
it is not an HTTP-404 contract.

Run `node scripts/documentation/inventory.cjs` from the repository root after
changing topics/routes. Review `inventory.json`: it covers every dashboard page
in source, including hidden and redirect routes, and all 14 existing modules.
This is a code/navigation inventory, not proof that a provider workflow works.
Separate administrator/support portals retain their own authentication and
operator documentation. Their control-plane routes are not ordinary user steps.

## Render diagrams

The `.mmd` files are actual Mermaid sources. Their reviewed SVG output is checked
into `client/public/documentation/diagrams` and displayed as same-origin images.
No Mermaid JavaScript, CDN, remote renderer or package addition is needed in the
deployed client. This also avoids a diagram parsing failure hiding a workflow.
The page includes image alternative text, visible prose descriptions and named,
keyboard-scrollable regions for narrow screens. SVGs use a white diagram canvas
for readable contrast in both dashboard themes.

Authoring prerequisites: the repository's supported Node runtime and root
`@playwright/test` dependency, an installed Playwright Chromium browser, and the
isolated Mermaid 12.2.0 package lock in this directory. Install only when needed:

```powershell
npm ci --prefix scripts/documentation --ignore-scripts
node scripts/documentation/render.cjs
node scripts/documentation/inventory.cjs
```

An optional `DOCS_BROWSER_PATH` selects an existing Chromium executable. A
machine with limited system-disk space can set `TEMP`, `TMP` and npm's cache to
an existing work-drive directory. No browser download is required when the
repository's Playwright browser is already installed.

The renderer uses strict security, plain SVG text labels and deterministic IDs;
it rejects script, foreignObject and external-link output and requires Mermaid
accessibility metadata. See Mermaid's official
[render API](https://mermaid.js.org/config/usage.html) and
[security configuration](https://mermaid.js.org/config/schema-docs/config-properties-securitylevel.html).
The source/description and generated output must be reviewed together.

## Local validation

Run the documentation Vitest suite, assistant presentation tests, sidebar/header
tests, client source typecheck and a clean client production build. The browser
suite `client/e2e/documentation.spec.ts` runs against the real Next routes with
synthetic API/session fixtures, traverses every guide and image, tests 320px
overflow, searches, role/module links, signed-out redirect and the disabled
runtime notice. It forbids API writes. It does not certify live providers,
actual customer delivery or a deployed release. Follow the current human's
dev-only local-validation exception; do not fabricate CI or deployment results.
