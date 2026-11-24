# Support widget settings and customer feedback

Support AI → Embed & integrate links each active support team to Widget settings. Appearance is saved per team: display name, greeting, six-digit brand color, publicly available HTTPS logo, and bottom-left/bottom-right launcher position. The local preview never calls the widget chat API or creates a customer session. A blank display name uses the business name. Changes apply on website reload; the loader uses `Cache-Control: no-cache`.

## Installation and key lifecycle

1. Add an active support team member and generate a key.
2. Customize the widget, copy the floating-button code and publish it before the closing `</body>` tag.
3. Open the customer website, then click Check installation in Embed & integrate.
4. Open the live chat and send a test message to verify the complete conversation.

The installation signal records the last hostname, normalized Origin, and server timestamp when the loader runs. An actual browser sends `POST /api/support-widget/installed` with `{ token, origin: window.location.origin }`, no cookies. The controller compares the HTTP Origin with the submitted origin and derives the hostname from that Origin. No website URL is fetched from the server. The signal confirms loader execution; it does not claim that messages are delivering or that the widget is currently online. Inline iframes/direct links do not produce a loader signal.

Rotate key requires an explicit dialog and clears the old installation signal. Existing installs and direct links stop working until updated. Revoke key disables all installs using the current key; generate/install a new key to re-enable. Authenticated ownership and the existing business scope apply to settings and key changes.

## Customer session behavior

History reads stop while the tab is hidden, never overlap, abort after 12 seconds, and back off from 5 seconds up to 60 seconds after transient failures. Transient failures retain session credentials. Expired or invalid credentials prompt a new chat. Persistent storage can be blocked by an embedded browser without breaking the active in-memory conversation. Automatic scroll follows new messages only while reading near the bottom; Jump to latest is shown while reading older history.

Customer feedback is stored on the session as `metadata.customerFeedback = { rating: 'helpful' | 'not_helpful', comment?: string, ratedAt: ISO timestamp }`. Optional comments are limited to 1,000 characters and redacted before persistence. `POST /api/support-widget/session/:sessionId/feedback` requires the widget token, the session credential, an unexpired session belonging to that token's team, and the same widget iframe Origin recorded at creation. Legacy sessions fall back to configured `CLIENT_URL`. It uses the existing public write rate limiter. Ambient cookies do not authenticate this endpoint. The dashboard can aggregate this feedback without exposing session credentials.

The customer handoff notice reflects an existing linked support ticket in `open` or `in_progress` state. The widget does not create or promise a handoff action itself.

## API and migration

- `GET /api/support-widget/token`: existing token/team fields plus `settings` and `installation`.
- `PUT /api/support-widget/settings/:teamId`: authenticated full settings object.
- `DELETE /api/support-widget/token/:teamId`: authenticated revoke.
- `GET /api/support-widget/config?token=...`: public appearance configuration.
- `POST /api/support-widget/installed`: public token plus matching website Origin.
- `POST /api/support-widget/session/:sessionId/feedback`: public token and bound session credential.
- History preserves the existing `data` array and adds `session: { expiresAt, handoff, customerFeedback }`.

Apply custom-runner migration `320_support_widget_settings.js` before serving these updated controllers. It adds `support_teams.widget_settings` (JSONB with an empty-object default for older teams) and `widget_installation` (nullable JSONB). Up is idempotent and down drops only these columns. The migration was exercised up/up/down/up inside a disposable local PostgreSQL fixture; no shared or remote database was changed.
