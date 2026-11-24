# Performance marketing workspaces

## Product boundary

- **Paid Ads** (`/dashboard/ads`) manages and measures paid Meta and Google campaigns. It is the only performance-marketing surface that can expose provider delivery actions or pause-only AI consent.
- **Social Insights** (`/dashboard/marketing/analytics`) measures organic Facebook, Instagram, and YouTube activity. It does not manage paid campaigns.

The navigation intentionally exposes only these two destinations. Legacy Ads URLs remain redirects so saved links and notifications continue to work.

## Paid Ads

Paid Ads has four URL-addressable tabs:

- `overview`: decision-oriented KPI chain, selected trend metric, attention queue, and performer comparison.
- `campaigns`: complete campaign inventory and provider delivery actions.
- `recommendations`: evidence-backed recommendation review queue.
- `automation`: account mode, campaign pause consent coverage, safety boundaries, manual holds, and activity.

Campaign detail opens as a dedicated, full-width page:

- Managed: `/dashboard/ads/campaigns/managed/:id`
- Provider report-only: `/dashboard/ads/campaigns/provider/:platform/:campaignId`

Each page contains Summary, Ads & ad sets, Creative preview, Recommendations, Automation & activity, and Technical details. Paid Ads no longer has a global Standard/Advanced switch. Provider identifiers, policy evidence, thresholds, and raw diagnostics are isolated in Technical details without changing permissions or consent.

Shareable workspace query parameters include `tab`, `period`, `comparison`, `platform`, `objective`, `status`, `metric`, `search`, and `date`. Campaign pages preserve `tab`, `unit`, `ad`, and `action`. Legacy `campaign`, `provider`, `providerCampaign`, and `detail` links redirect to the canonical campaign page.

## Social Insights

Social Insights has Overview, Listening, Competitors, and Reports tabs. Platform, account, start date, end date, sentiment, tab, and view mode are shareable URL state.

Standard view contains business metrics, trends, plain-language evidence-grounded guidance, best publishing times, listening summaries, competitor deltas, and friendly report scheduling. Data synchronization and timezone controls live in Data & connections. Advanced view additionally reveals immutable snapshot identifiers, citations, manual normalized evidence import, source event IDs, and legacy cron compatibility.

Friendly report schedules store local frequency, day, time, and IANA timezone. Existing five-field UTC cron records continue to execute and are labelled as legacy schedules in Standard view.

## Safety and analytics

The redesign does not change the deterministic ad policy engine or provider mutation boundaries. Recommendation acceptance opens an editing workflow. Autonomous execution remains pause-only and requires both valid account consent and campaign consent.

Privacy-safe product events are emitted through `asksales:analytics` and `window.dataLayer` when available. Events include workspace/tab/view/filter changes, campaign-detail opens, recommendation review outcomes, Data & connections opens, and report saves. Payloads exclude campaign names, account identifiers, provider resource IDs, and evidence bodies.

## Acceptance coverage

Automated contracts cover route compatibility, Paid Ads technical disclosure, Social Insights Standard/Advanced disclosure, URL state, safety controls, provider-error states, timezone scheduling, recommendation review, and responsive/accessible affordances. Final browser acceptance is run in Chrome at desktop and mobile widths with console and network inspection enabled; live provider mutation controls are not exercised during UI verification.
