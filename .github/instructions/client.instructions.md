---
applyTo: '**'
---

# Client Instructions for GitHub Copilot

## Operational log recovery

- System Logs cancels superseded reads and only the latest request may update rows/errors/loading.
- Date filters display device-local wall time and send explicit ISO instants to the API.
- Failed statistics are unavailable or visibly stale, never fabricated zero counts. Retained logs
  and statistics identify the last successful refresh and expose independent retry controls.
- Disclosure and statistics filters use native named buttons. Keep visible filter labels, expanded
  state, keyboard focus and normal-zoom desktop/mobile layouts when changing these surfaces.

## Tech Stack Summary
- **Framework**: Next.js 16.1.6 (App Router)
- **Language**: TypeScript 5
- **State**: React Query v6, React Context (6 contexts)
- **UI**: Tailwind CSS + shadcn/ui (47 components)
- **Forms**: React Hook Form v7 + Zod v4
- **Charts**: Recharts v3, ApexCharts
- **Workflow**: ReactFlow v11
- **Animation**: Framer Motion v12

## Directory Structure
```
client/src/
├── app/              # 50+ routes (public, dashboard, admin, support)
├── components/       # 80+ components (ui, tabs, modals, chat, outreach)
├── contexts/         # 6 contexts (Auth, Admin, Support, Agent, etc.)
├── hooks/            # 4 hooks (mobile, toast, setup, workflow)
├── services/         # API & WebSocket services
├── lib/              # API client, query client, utilities
├── models/           # 19 TypeScript interfaces
└── utils/            # Helper functions
```

## Key Routes
- **Public**: `/`, `/login`, `/register`, `/forgot-password`, `/privacy`, `/terms`, `/refund-policy`, `/cancellation-policy`, `/account-deletion`, `/pricing`
- **Setup**: `/setup/business-profile`, `/setup/brand-toolkit`, `/setup/account-verification`
- **Dashboard**: `/dashboard/home`, `/dashboard/leads`, `/dashboard/chat`, `/dashboard/saved-templates`, `/dashboard/content-calendar`, `/dashboard/brand-toolkit`, `/dashboard/outreach`, `/dashboard/marketing`, `/dashboard/support`, `/dashboard/settings`
- **CRM Configuration**: The Contacts header button and CRM sidebar link open `/dashboard/crm/configuration`, a Stages → Preferences → Confirm editor saved for the selected business profile. Use `useCrmConfiguration` for stage names, order, colors, and options across Contacts, Pipeline, Alerts, and Automations. The support agent uses these names and types for semantic contact transitions; stage type (not its label) determines Won/Lost, and In flow controls analytics visibility only. Keep stable stage keys and previously assigned statuses discoverable; a configuration load failure must not allow saving fallback defaults over stored settings.
- **CRM preferences**: Use `PlatformMultiSelect` for reporting platforms. At least one checkbox stays selected, All Platforms is exclusive, and connection status describes available accounts without excluding historical channels. Read legacy scalars and arrays with `crmSelectedPlatforms` / `crmPlatformLabel`. Custom configuration/report dates use inclusive UTC calendar days; contact history dates use local days converted to an exclusive UTC upper bound. Configuration saves include its revision; tab-scoped recovered drafts must match the selected business and saved revision. Preserve drafts on rejected saves, guard unsaved navigation, and never save fallback configuration after a load error.
- **CRM contact workspace**: `/dashboard/crm/contacts/[id]` loads the profile immediately, then its next-action summary and active history only. Use `useContactWorkspace` query keys containing actor, selected business, contact, tab and filters, with abortable reads and targeted invalidation. Conversations, sent outreach, combined timeline, activity and tickets have independent server search/filter/pagination; conversation totals count threads. Older messages use the verified contact endpoint with `beforeMessageId`. Show owner, stage, follow-up and ticket urgency clearly; desktop has an overview sidebar and mobile opens the same overview in Contact details. Keep expansion controls keyboard accessible, ticket links outside expansion buttons, sanitized message HTML, and recoverable loading failures.
- **CRM edits and delivery**: Share `ContactEditForm` between the contact dialog and `/dashboard/crm/contacts/[id]/edit`. Save fields, configured stage, owner, tags and deal details in ONE PUT with the original `expectedUpdatedAt`; stale edits keep their draft for comparison. The dedicated pipeline-status PATCH remains for board stage moves. Reply drafts are tab-scoped by business/contact/conversation/provider account, with stable attempt keys. Load real inbox sending context and send the explicitly reviewed recipient/account. In-progress or uncertain outcomes keep the draft and require inbox review; never toast them as confirmed delivery. Ticket replies/internal notes/status use the existing support endpoints and module access; closure copy must disclose its configured notification. Use `ContactReminderDialog` / `ContactReminderList` for direct follow-ups, including assignment, completion and snooze; emailing a contact is explicit opt-in.
- **CRM collections and reporting**: Contacts use server sorting, owner/tag/priority/follow-up filters, business/user-scoped saved views, checked-record bulk actions and full filtered CSV export. Reset selected records and dialogs when the business changes. Pipeline loads stage summaries and 20 contacts per stage, retaining earlier cards on load-more failures. `/dashboard/crm/work` shows assigned reminders, unanswered conversations, stuck contacts and tickets needing attention; counts reflect filters and actions use actual reminder IDs. `/dashboard/crm/reports` overrides reporting platforms/dates explicitly and links stages/channels to filtered contacts. Label distributions, stage transition counts, observed stage visits and lifetime channel totals accurately; keep currencies separate. `CrmNavigation` provides consistent links across the collection pages.
- **AI Visibility**: `/dashboard/ai-visibility` plus its SEO, AEO, GEO, Commerce, Competitors, Fixes, Assets, and Reports sidebar destinations. It resolves the selected/default Business Profile automatically. Additional domains use the reusable **Analyze any website** search/history workflow; do not add a duplicate brand-profile onboarding form.
- **Storage**: `/dashboard/storage` uses `useStorageWorkspace` and the components in `components/storage`. React Query keys include the actor and selected business; switching profiles remounts dialogs, selections and upload queues. The workspace API handles cursor pagination, literal name search, MIME/date/size/tag/collection filters, complete actor-run counts and activity. Filters live in the URL; list/grid preference is stored locally. Render large loaded lists and grids in bounded windows. File names open details; previews support bounded text/JSON/CSV and media with previous/next among loaded files. Download through scoped, one-use tickets so the browser streams files and ZIPs. Uploads use a multiple-file queue with progress, cancel and a stable `X-Storage-Upload-Id` for retries. Preflight new uploads only; retries must resolve a previously committed receipt even when capacity is full. Trash retains quota for 30 days; dependency review is required for linked/generated assets, and permanent deletion requires a separate confirmation. Capacity is organization-wide; file counts and listings belong to the selected business.
- **MSG91 SMS**: `/dashboard/integrations/msg91` uses the shared connection workspace and guide; `/dashboard/integrations/msg91/events` uses the shared webhook activity view. `msg91State` marks SMS connected only when the API reports `connected: true` and `connectionStatus: ready`. Keep saved identity separate from draft fields; blank Auth Key preserves the saved key, testing a draft does not connect it, and a status load failure must block overwriting saved settings. Display delivery and optional incoming callback URLs from `/api/webhooks/config`. SMS is also available in the shared outreach composer, inbox, and CRM outreach dialog; sending uses the reviewed MSG91 sender and recipient phone, with no email subject or attachments.
- **Admin Panel**: `/admin/*` (170+ routes for system management, integrations, users, analytics)
- **Admin billing wallet controls**: Read the verified `useAdminAuth()` session.
  Ordinary administrators retain wallet/history reads; only a nonloading
  `super_admin` session exposes credit/plan mutations and subscription settings.
  Invalidate open billing forms on role/account/revalidation changes. Retained
  callbacks and late results from an older form must not submit, close a newer
  draft or display its success. Backend authorization stays authoritative; no
  automatic retry or reversal follows a session change.
- **Support Portal**: `/support/*` (separate auth via `support_token`)

### Legal Content Management
- Public legal content is served from API-managed markdown pages (`/privacy`, `/terms`, `/refund-policy`, `/cancellation-policy`, and `/policies/[slug]`)
- Admin can manage legal markdown pages from `/admin/dashboard/policies`
- Account deletion requests are submitted from `/account-deletion` and reviewed in admin policies page

## Important Auth Patterns
**THREE SEPARATE AUTH SYSTEMS - NEVER MIX THEM:**
1. **Main App** (`useAuth()`) → `token` localStorage, `/api/auth/me`
2. **Admin Panel** (`useAdminAuth()`) → `admin_token` localStorage, `/api/admin/me`, routes under `/admin/*`
3. **Support Portal** (`useSupportAuth()`) → `support_token` localStorage, `/api/support-portal/me`, routes under `/support/*`

Each has its own API client, context, and token. NEVER use `useAuth()` in admin pages—always use `useAdminAuth()`.

## Tab System (Chat Interface)
Tab types defined in `client/src/lib/tabConfig.ts`:
- **TAB_TYPES constants**: `OVERVIEW`, `ICP`, `LEADS`, `OUTREACH`, `CAMPAIGNS`, `CONTENT_STUDIO`, `PERFORMANCE_MARKETING`, etc.
- **Default**: Overview tab always shown first
- **Dynamic creation**: Server sends `open_tab` WebSocket event with `tabType`
- **Persistence**: Saved to `chat_tab_configs` table

## API Client Pattern
```typescript
import { api } from "@/lib/api";
const data = await api.get<T>('/api/items');  // GET
const result = await api.post<T>('/api/items', body);  // POST
// Always includes credentials: 'include'
```

## React Query Pattern
```typescript
const { data, isLoading, error } = useQuery({
  queryKey: ['items', userId],
  queryFn: () => api.get<T>('/api/items')
});

const mutation = useMutation({
  mutationFn: (data) => api.post('/api/items', data),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['items'] })
});
```

## Component Pattern
```typescript
interface Props { title: string; onAction?: () => void; }
export function MyComponent({ title, onAction }: Props) {
  return <div>{title}</div>;
}
```

## Forms with Zod
```typescript
const schema = z.object({ name: z.string().min(1) });
const form = useForm({ resolver: zodResolver(schema), defaultValues: {} });
```

## Critical Notes
- Always use `credentials: 'include'` for API calls
- Use `@/` alias for imports (maps to `src/`)
- Protected routes wrapped with `ProtectedRoute`
- WebSocket context provides real-time updates
- Toast notifications via `useToast` hook
- Recharts `formatter` should NOT have explicit type annotations
- Dark mode via `next-themes`
- Dynamic routes: `[id]`, catch-all: `[[...slug]]`
- Admin shares same `QueryClientProvider` and shadcn/ui components as main app

## Admin Panel Overview
Admin panel migrated into client under `/admin/*`. Same stack as client + ReactFlow.
- **Auth**: `useAdminAuth()` with `admin_token`
- **Layout**: `AdminDashboardLayout` with sidebar
- **Protection**: `AdminProtectedRoute` component
- **API**: `admin-api.ts` client (401 redirects to `/admin/login`)
- **Routes**: 170+ covering users, integrations, billing, queues, system logs

## Styling
- Shared overlay layers are declared in `src/app/globals.css`. Keep header/navigation below root floating controls and modal backdrops. `components/ui/layers.tsx` carries modal ownership through body portals; floating controls inside a modal use its reserved floating level, and nested modals use the next modal level. Preserve Radix/Vaul focus and dismissal behavior when changing these wrappers.
- Use semantic surface/foreground/border/muted/primary/ring tokens for page finders and other operator controls so settled, selected, empty and keyboard states follow the active theme.
- Tailwind classes with responsive prefixes (`sm:`, `md:`, `lg:`, `xl:`)
- Dark mode with `dark:` prefix
- CSS variables: `bg-primary`, `bg-secondary`, `bg-destructive`, `text-muted-foreground`
- Grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`

## References
- Full client guide: See `client.instructions.md` in reference directory
- Component inventory: 80+ components organized by type
- All 50+ routes documented with purpose and dynamic segments
- Admin panel routes: 170+ routes for system management

## Account and workspace settings discovery

- `/dashboard/settings` is Account settings (profile, security and personal notifications). Preserve its existing tab URLs, including `?tab=support`, which is a permission-aware link surface for workspace support alerts.
- `/dashboard/settings/workspace` is a navigation-only Workspace configuration overview. Use `lib/settings-navigation.ts` for canonical labels, routes, scope and module/role filtering; configuration stays on the existing pages and APIs. Assistants at `/dashboard/settings/outreach` require `support_ai`, despite the legacy route name. Connections are offered to owners/billing admins; support administration to owners; staff and assistants show view-only access for other workspace roles. Resolve the selected business profile role rather than the account's default role, and withhold links on loading/failed verification.
- Contextual settings pages use `WorkspaceSettingsScope` to identify the selected workspace. Assistants identify the receiving account/channel in assignments; widgets identify the selected support team and website channel. Retain operational-module links, direct-route/API guards and legacy redirects. Proposal settings remount their existing policy form on a selected-workspace change.

## Assistant settings and operations

- Assistant settings live in `components/outreach/assistants/`; the Operations page is `/dashboard/settings/outreach/operations`. Keep catalog/list/report query keys scoped to the authenticated user and business profile. Assistant lists use cursor pages; resource pickers preserve hidden selections and render bounded pages.
- Use the shared `AssistantAssignmentRows` in both settings and operations. Show connection, runtime enablement, immutable published revision and readiness separately. Needs-attention published assistants still show their enabled bindings, not the next draft's assignments.
- Setup guidance links to actionable sections. Guided policies are the default; advanced JSON must validate before saving. Structural draft recovery is tab-local, version-scoped and expires after 24 hours; do not store instructions, customer examples, policy text or other free text in browser recovery. Restoring never saves or publishes automatically.
- `AssistantTemplatePreview` is shared with follow-up creation. Use fictional sample variables, reject unsupported tokens, and distinguish business approval from provider messaging permission. Preview never sends.
- Saved simulator scenarios run sequential messages against isolated signed preview sessions, with bounded history and explicit assertions. Draft and published comparisons use separate sessions; show recorded stage/model outcomes without claiming suppressed side effects happened.
- Operations reports show finalized customer outcomes, exact assistant-attributed model usage, optional recorded model-cost estimates (not invoices), and persistent knowledge reviews. Missing cost is not zero. Knowledge gaps distinguish conflicting/stale sources and show redacted question samples, daily counts and real conversation links.
- Inbox/CRM activity uses canonical outreach IDs and lazy cursor loading. PDF/proposal events show actual persisted statuses/receipts; only owned proposal records produce proposal links. Revision rollback requires comparison, expected draft version and explicit account confirmation.

## Instagram automation hub

- Templates require the business's own HTTPS link or opening hours, then remain editable. Duplication calls the account-scoped server endpoint with the source revision and always creates a paused copy. Follow-to-unlock has a dedicated title/flow; its catalog counts exclude standard DM rules and vice versa.
- Recover unfinished profile/rule edits in tab-local session storage, scoped by business profile, account, editor and saved revision. Offer explicit restore/discard; discard expired or superseded copies. Clear recovery after successful save/removal or confirmed discard. Never publish or activate a recovered draft automatically.
- Main menu actions support drag ordering and keyboard move controls without regenerating IDs/payloads. Industry question presets apply only to the chosen language; keep explicit fallback/preview language guidance.
- Potential overlaps use the shared matcher and precedence, including exclusions and intersecting media. Activation requires a plain-language review. Test & delivery is inside an automation; sample matching uses the saved server definition and does not send messages. Receipts are filtered by rule ID. Keep all History/activity navigation off the landing catalog.
- Connection health uses the account-scoped `/readiness` endpoint and gives reconnect/admin actions. Media pages use a bounded, 60-second, business/account/cursor cache with in-flight deduplication and explicit refresh; never cache credentials or failed reads.
- Catalog connection labels distinguish saved account authorization from permission, subscription and rollout readiness. Use `instagramAccountAuthorization` and `instagramCardConnection`; unavailable feature access alone must never imply disconnection. The hub's explicit Check connection action reads `readiness?verify=1`, and returning to the app refreshes saved status. `AutomationDemo` illustrates each card in local, keyboard-controlled steps, including the exact selected question/menu action and the full follow → DONE → verification sequence. These examples make no API calls or external changes.

- The hub is `/dashboard/integrations/instagram/automations`, implemented in `components/instagram-automations/`. Preserve the explicit `accountId` in navigation; remount on business profile/account changes so unsaved rules cannot move between accounts.
- The landing view is a five-card catalog: Conversation starters, Main menu, Comment to DM, Public comment reply, and Follow to unlock. Keep Comment rules/History navigation and recorded activity off the catalog. Card actions open account-bound setup or saved-automation views; `preset=follow` enables follow verification in a new DM rule. Saved-automation views initialize their kind/preset filter from the URL.
- Wizard and advanced editor share `InstagramRuleDefinition` and validators from `shared/instagramAutomations.ts`. New rules are paused. Initial comment private replies use text; rich formats are available only after a supported messaging interaction.
- Profile status distinguishes drafts, pending verification, confirmed publication, and sync errors. Never present a provider error as published. Phone previews are simulated. Metrics describe recorded triggers and accepted sends, not reads.
- Tests: `src/__tests__/instagramAutomations.test.tsx` and `e2e/instagram-automations.spec.ts` (desktop/mobile with isolated API fixtures).
- Keyword/tag fields commit on blur; first question/reply/menu inputs are visible immediately. Generate menu action identifiers automatically, preserve unsaved edits on rejected navigation, and ignore responses from an earlier account/view. Failed refreshes preserve loaded configuration and offer retry.
- Show UTF-8 byte limits for text/follow prompts and the 640-character button text limit. Wizard Next validates the current step. Optional carousel properties follow the shared validator. `e2e/instagram-automations-audit.spec.ts` captures every page on desktop/mobile using the opt-in real HTTP/Postgres harness described in the rollout guide.
- Use explicit field labels, reserve space for a typed token before committing it on blur, and clear stale validation notices while the person edits. History records stack their outcome and details on small screens, while retaining the desktop table.

Instagram's main integration settings mount `InstagramConnectionHealth` for authorized accounts. Initial display uses saved readiness; the explicit Check connection health button verifies current event subscriptions. Keep this visible outside the developer credentials panel.

## Follow-up settings and outreach drafts

- Open channel follow-up settings from the outreach composer in its local dialog. The `followUpSettings=1` query preserves browser Back/Forward navigation while retaining the in-memory composer, sender, recipients and schedule. Closing discards unsaved settings edits; saving refreshes the channel summary and returns any reviewed outreach to editing.
- Private outreach/settings/template forms remount on authenticated actor or selected business changes using `useOutreachDraftScope`. Keep their text in memory; never recover it across accounts. Cancelled template creation clears its draft; failed creation/save retains it for correction. Ignore completions after the owning form unmounts and suppress duplicate in-flight submissions.
- Send the channel settings `revision` as `expectedRevision` on saves. A conflict preserves the draft and offers explicit discard/reload; do not overwrite it with a fallback configuration. Delays must remain whole-number minutes, hours or days and preserve the complete stored duration.

- The composer owns follow-up save lifetime. Save start immediately invalidates its review; completion must refresh the owning channel even if the settings child was dismissed. Ignore callbacks from a prior actor/business or inactive channel. Unknown transport/confirmation outcomes retain every unresolved operation and block review until an attested changed fence resolves its expected revision or a confirmed retry safely advances the fence. Equal settings at the original revision do not prove a delayed write cannot commit. Snapshot readiness must invalidate synchronously on reload so a retained click handler cannot launch against a stale review.
- When session-storage writes fail, restore both the structural history ledger and its persistence obligation for every actor/business/channel scope before any settings read settles. The persistent application provider carries this metadata across ordinary pathname navigation; module startup and `pageshow` restore dormant scope ledgers before a later reload. Keep private form wording out of recovery, preserve Next's existing history flags during backup, and pass only recovery metadata for same-page query changes.
- Use Next.js native history integration for same-page dialog queries, and consume private `message` handoff text after its first scoped import. Scope remounts and returning to the original scope must not re-import a retained private handoff. Template creation uses the API client’s stable recovery key; clear it only for a valid confirmed template receipt.

## Billing recovery and review

Billing term controls stay disabled while checkout creation is pending. A canceled mandate remains selectable for reauthorization. Administrator plan review must capture its organization target and be cleared on a target change. Legacy storage follows the actual account allowance rather than a public Unlimited promise; see `docs/tenant-billing-integrity.md`.

## Bulk outreach queue uncertainty

The central composer displays an unconfirmed queue receipt separately from
accepted and definitively failed items. Keep its conversation link and warning
that saved work may still send; exclude uncertain items from the failed-recipient
retry action. A queue acknowledgement is not proof of recipient delivery.
## Follow-up settings and interrupted requests

- Use the shared `ChannelFollowUpSettingsDTO`: retain opaque step IDs and explicit enabled flags, including disabled zero-delay rows. Validate ordering among enabled rows only; do not silently enable or renumber disabled steps. Preserve expected-revision fencing and the distinct legacy API contract.
- Standalone follow-up settings and composer settings share `follow-up-save-recovery`. Pending/uncertain standalone saves must also block outreach review until the existing attested fence contract reconciles them. Keep structural browser recovery free of private wording and preserve history/pageshow ownership checks.
- Bound history and template operations with `followUpRequest`, including response parsing. An aborted or timed-out POST is unconfirmed, not cancelled. Retain an uncertain template's exact in-memory body and the existing `contentRequestKey` receipt across close/reopen and explicit retry; never mint a competing retry identity after a late acknowledgement. Clear normal cancelled drafts and remount private forms on actor/business/channel changes. Do not store private wording in browser recovery.
- Template dialogs return focus to their actual library/step opener. Created templates still need business approval in the library; preview and creation never imply provider sending permission.
## Administrator reporting

Per-user usage consumes `shared/adminUserUsage.ts`: model tokens, scraped items and validated emails are independent measurements. Display the API's reported period; unavailable measurements must not look like a successful empty report. Keep the back link named and avoid nested interactive controls. Billing-account discovery is bounded to 100 results and must display the server's `hasMore`/`resultLimit` narrowing guidance. Keep the existing plan-target remount and distinct user-default versus organization wallet workflows.
## CRM saved-action recovery

- Contact edits, pipeline changes and bulk updates distinguish saved fields from automation review or final refresh failure. Show per-contact bulk recovery links and persist transition status in the contact's Automation recovery section. Offer only pending discovery retry; started/uncertain actions require review, and queued 314 events remain owned by the automation engine.
- The import wizard reconciles `ApiError.data.importId` through the existing status API and resubmits the identical file/mapping after a lost response. Scope browser receipts to the actor/business, retain only checksum/mapping/import ID (never CSV contents), verify a reselected file, freeze the original mapping during recovery, and ignore former-scope responses. Starting a separate import clears only the browser draft; previously saved rows remain in CRM. Keep duplicate handling in the backend's existing skip mode; overwrite policy is a product decision.


## Campaign manual sequence review

The outreach composer `/dashboard/outreach/create` exposes **Use a campaign manual sequence**, **Manual follow-up campaign**, ordered minute delays, approved templates, and **Save campaign sequence**. Campaign workspaces supplied through an explicit `threadId` load their saved sequence; no latest/recent campaign is guessed. Creating a campaign creates a normal outreach `chat_threads` workspace, not a parallel campaign identity. Draft campaign creation/settings saves work while customer delivery readiness is blocked. Later batches load the selected campaign's persisted revision.

`CampaignManualSequence` guards list/template/sequence/create/save responses against old actor/business/channel/campaign contexts. Dirty, loading, failed or uncertain saves block manual review. Existing batch review shows the personalized manual steps and immutable sequence/template revisions for each recipient, then submits only the reviewed token. Do not submit both campaign manual and global/inline steps. Global defaults may only be copied through the explicit preset button.

**Preview revision for unsent enrollments** is separate from saving. Show each exact enrollment/recipient/new message and require explicit confirmation before applying. A stale review or unsafe delivery state must remain blocked, with no automatic replay. Preserve runtime/setup guidance, disabled customer-send actions and editable initial-message drafts.

## Public Documentation

`/documentation` and `/documentation/:topic` expose generic guides anonymously in the public layout. Previous `/dashboard/documentation/:path*` links permanently redirect to the public URLs. Guides live in `client/src/content/documentation`; do not include private customer data or operator credentials. Keep source evidence references and the generated route/topic inventory current. Public guides withhold workspace action links; destination dashboard routes/APIs retain their ordinary role, module, setup, subscription and maintenance checks.

Use `documentation-navigation.ts` for contextual help in the dashboard header/account menu. Keep blockers, errors, confirmations and next actions on operational pages; put long explanations in the linked guide. The assistant runtime block remains mandatory. Never describe setup as automatic replay of held work, or ticket ownership as proof of AI readiness.

Mermaid sources live in `scripts/documentation/diagrams`. Re-render reviewed same-origin SVGs with the isolated authoring tool described in `scripts/documentation/README.md`. No Mermaid library or external renderer runs in the deployed client. Keep accessible descriptions and keyboard-scrollable diagram/table containers.
