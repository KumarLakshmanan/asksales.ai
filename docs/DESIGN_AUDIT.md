# AskSales.ai — Product Design Audit Report

> **Audit Date**: 2025-05-19  
> **Scope**: Full client application (260 route pages, 80+ components)  
> **Perspective**: Senior product designer, frontend architect, QA engineer, SaaS consultant  
> **Application State**: Functionally complete; preparing for production launch  

---

## Executive Summary

AskSales.ai is a feature-rich AI-powered sales platform. The core functionality is sound and the codebase is architecturally solid. However, several recurring patterns reduce product quality and create friction for real-world users:

1. **Silent error handling** throughout the dashboard leaves users confused when things go wrong  
2. **Inconsistent loading/skeleton patterns** break perceived performance  
3. **Mobile responsiveness gaps** — many dashboard grids jump from desktop to single-column with no intermediate mobile breakpoints  
4. **Large, monolithic components** that are hard to maintain and slow to render  
5. **State management fragmentation** — some pages use React Query, others use raw useState+useEffect  
6. **A few "coming soon" placeholders** visible in production  
7. **Security gap** in Next.js image configuration  

Overall quality score (below), but these are all fixable with moderate effort.

---

## UI Issues

### UI-01 — Hardcoded Chart Colors
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/home/page.tsx` (lines 25–35), all chart components  
**Problem**: Chart color palettes are hardcoded hex values (`#7c5ce6`, `#b48cf2`, etc.) rather than CSS custom properties from the theme system.
```tsx
// Current — brittle, ignores dark mode
const CHART_COLORS = { primary: "#7c5ce6", secondary: "#b48cf2", ... };

// Better — theme-aware and responsive to dark mode
const CHART_COLORS = { primary: "hsl(var(--primary))", ... };
```
**Why it matters**: Charts don't adapt to custom brand themes or dark mode properly. Break the design system consistency.  
**Fix**: Replace all hardcoded hex values with CSS variable references via `hsl(var(--color-name))`.  
**Expected impact**: Consistent charts across themes, no light/dark mode visual mismatch.

---

### UI-02 — "Activity Log Coming Soon" Visible in Production
**Severity**: High  
**Affected**: `client/src/app/dashboard/(main)/settings/page.tsx` (line 311)  
**Problem**: A literal "Activity log coming soon." message is displayed to end users inside the Settings page.
```tsx
<p className="text-xs text-muted-foreground py-4 text-center">Activity log coming soon.</p>
```
**Why it matters**: Incomplete sections damage user trust in a production SaaS product. Users expect all settings areas to be functional.  
**Fix**: Either implement the activity log or remove the placeholder entirely. If a timeline exists, replace with a purposeful empty state (e.g., "No recent activity").  
**Expected impact**: Removes impression of unfinished product.

---

### UI-03 — Knowledge Base Page "API Not Yet Implemented" Comment
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/knowledge-base/page.tsx` (line 119)  
**Problem**: A developer comment `// Show empty state if API not yet implemented` is in production code. While the comment is invisible to users, the behavior it guards may show an empty state when data should exist.  
**Fix**: Implement the API or handle the empty state without the comment.

---

### UI-04 — DashboardLayout Sidebar Text-Only Loading State  
**Severity**: Medium  
**Affected**: `client/src/components/DashboardLayout.tsx` (line 293)  
**Problem**: While chat threads are loading (`loadingThreads`), a plain "Loading..." text is shown. The rest of the sidebar uses polished skeleton loaders, making this feel inconsistent.  
**Fix**: Replace with a skeleton loader matching the thread item layout:
```tsx
// Instead of: <p>Loading...</p>
Array.from({ length: 5 }).map((_, i) => (
  <Skeleton key={i} className="h-10 w-full rounded-lg mb-1" />
))
```
**Expected impact**: Consistent perceived loading quality across the sidebar.

---

### UI-05 — Inconsistent Card Styles and Border Radiuses
**Severity**: Low  
**Affected**: Multiple dashboard pages (leads, integrations, CRM, outreach)  
**Problem**: Some cards use `rounded-xl`, others use `rounded-lg`, and some use `rounded-2xl`. Border widths vary between `border` (1px) and `border-2`. This creates a visually inconsistent feel at a detail level.  
**Fix**: Standardize on `rounded-xl` for cards and `border border-border/60` for internal cards. Reserve `rounded-2xl` for hero sections only.  
**Expected impact**: More cohesive, premium visual language.

---

### UI-06 — Empty States Vary in Quality
**Severity**: Low  
**Affected**: Email outreach, CRM contacts, leads filters  
**Problem**: Some empty states have icons + title + description + CTA. Others just say "No leads found" with no guidance. Inconsistent quality creates a patchy experience.  
**Fix**: Apply a standard empty state pattern everywhere:
1. Icon (muted, on-brand)
2. Title ("No X yet")
3. One-sentence description
4. Optional CTA ("Add your first X")

---

## UX Problems

### UX-01 — Silent Error Handling Across Dashboard  
**Severity**: Critical  
**Affected**: `leads/page.tsx` (lines 163, 186, 213, 242, 388), `home/page.tsx`, `outreach/email/page.tsx`  
**Problem**: Dozens of `catch` blocks across dashboard pages silently swallow errors. Users see nothing when API calls fail — no toast, no error message, no retry option.
```tsx
// Current — silent failure
catch (_error) {
  setIsLoading(false);
}

// Expected — user-visible feedback
catch (error: any) {
  toast({ title: "Error", description: error.message || "Failed to load leads", variant: "destructive" });
  setIsLoading(false);
}
```
**Why it matters**: When the API is slow, rate-limited, or returns errors, users see broken/empty screens and don't know if the page loaded or failed. They can't retry or seek help.  
**Fix**: Audit all `catch` blocks across the dashboard. Add toast notifications for every user-facing failure.  
**Expected impact**: Eliminated "why is this empty?" support tickets. Dramatically better perceived reliability.

---

### UX-02 — Chat Redirect Shows Visible "Redirecting..." Flash  
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/chat/[[...threadId]]/page.tsx`  
**Problem**: The `/dashboard/chat` route renders a visible "Redirecting..." text while performing `router.replace()`. Users see a flash of this text during navigation.
```tsx
return (
  <div className="flex items-center justify-center h-full">
    <div className="text-muted-foreground text-sm">Redirecting...</div>
  </div>
);
```
**Fix**: Use a loading spinner instead, or configure Next.js redirect in `next.config.ts`:
```ts
async redirects() {
  return [{ source: '/dashboard/chat/:path*', destination: '/dashboard/conversations/:path*', permanent: true }];
}
```
**Expected impact**: Seamless navigation, no visible flash during redirects.

---

### UX-03 — Setup Check May Silently Fail
**Severity**: High  
**Affected**: `client/src/app/dashboard/(main)/home/page.tsx` (lines 276–288)  
**Problem**: The `checkUserSetup()` function loads business profiles to determine whether to redirect new users to `/setup`. If this API call fails (network error, rate limit), the user stays on the dashboard even if setup is incomplete.
```tsx
catch (error) {
  // Nothing — user never gets redirected to setup
}
```
**Fix**: On error, either: (a) redirect to setup as a safe fallback, or (b) show a "could not verify setup" banner with a retry link.  
**Expected impact**: New users reliably land in setup flow when needed.

---

### UX-04 — Excessive Prop Drilling in ChatInterface
**Severity**: Medium  
**Affected**: `client/src/components/ChatInterface.tsx`  
**Problem**: The `ChatInterface` component accepts 15+ callback props (`onOpenAgentChooseTab`, `onOpenICPTab`, `onOpenLeadInputsTab`, `onOpenBrandToolkitTab`, `onCreateBrandToolkit`, `onOpenOutreachTab`, etc.). This creates tight coupling between the chat panel and every tab in the application.  
**Why it matters**: Adding or renaming a tab requires changes in 3+ files. Any missing prop causes a silent bug where the button appears but does nothing.  
**Fix**: Move tab management into a dedicated `TabContext` or `ChatActionContext`. Chat component dispatches action names; parent handles routing.  
**Expected impact**: Simpler component API, safer tab additions in the future.

---

### UX-05 — Lead Scoring/Enrichment / Validation Has No Per-Lead Visual Feedback
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/leads/page.tsx` (lines 95–105)  
**Problem**: State variables `scoringLeadId`, `enrichingLeadId`, `validatingEmailId` track which lead is being processed, but the UI doesn't show a spinner or loading indicator next to that specific lead row. Users can't tell which operation is running.  
**Fix**: Show a `<Loader2 className="animate-spin" />` icon next to the action button on the specific lead row while the operation is in-flight.  
**Expected impact**: Instant visual feedback, prevents double-clicking.

---

### UX-06 — No Bulk Actions in Leads List
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/leads/page.tsx`, `LeadsTab.tsx`  
**Problem**: Users can only act on one lead at a time. With 200+ leads, there's no way to bulk-delete, bulk-export, bulk-score, or bulk-email.  
**Fix**: Add multi-select checkboxes to lead rows + a floating action bar that appears when rows are selected.  
**Expected impact**: Major productivity gain for power users managing large lead lists.

---

### UX-07 — No Search in Integration Pages
**Severity**: Low  
**Affected**: All `/dashboard/integrations/*` pages  
**Problem**: Integration pages show grid cards but have no search or filter. As the number of integrations grows, finding a specific integration requires scrolling.  
**Fix**: Add a search input at the top of the integrations page to filter by name.  
**Expected impact**: Improved discoverability as integrations list grows.

---

### UX-08 — CRM Pipeline View Has No Drag-and-Drop
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/crm/pipeline/page.tsx`  
**Problem**: The pipeline board currently requires users to use a dropdown to change stages. Modern CRM tools (HubSpot, Pipedrive) let users drag cards between columns.  
**Fix**: Integrate a drag-and-drop library (e.g., `@dnd-kit/core` — already a common choice in React ecosystems) to support card dragging between pipeline columns.  
**Expected impact**: Much faster pipeline management, a key differentiator for a CRM product.

---

### UX-09 — No Keyboard Shortcut System
**Severity**: Low  
**Affected**: Global dashboard  
**Problem**: Power users expect keyboard shortcuts for common actions (e.g., `N` for new lead, `E` for email, `⌘K` for command palette). None exist.  
**Fix**: Implement a simple `⌘K` command palette using `cmdk` (compatible with existing shadcn/ui) as a first step.  
**Expected impact**: Significant productivity boost for repeat users.

---

### UX-10 — No Inline Editing in CRM / Leads Tables
**Severity**: Medium  
**Affected**: CRM contacts table, leads table  
**Problem**: To edit any field (email, company, status), users must navigate to a separate edit page. This creates unnecessary page transitions for minor updates.  
**Fix**: Allow double-click or pencil icon to open inline edit mode on specific columns (name, email, status) within table rows.  
**Expected impact**: Reduced clicks-per-task from ~5 to ~2 for common edits.

---

## Feature Enhancement Opportunities

### FE-01 — Email Outreach: No Email Preview Before Sending
**Severity**: Medium  
**Affected**: `client/src/components/modals/SendEmailModal.tsx`, email create page  
**Problem**: The Send Email modal has a "Preview" tab (`activeTab === 'preview'`) but it's not clear if the preview accurately reflects the rendered HTML email. Users can't reliably see what recipients will receive before sending.  
**Fix**: Render a proper HTML email preview iframe in the Preview tab using the actual template HTML with variable substitution applied.  
**Expected impact**: Fewer email mistakes, higher confidence for users.

---

### FE-02 — Email Outreach: No Delivery Status / Open Tracking
**Severity**: Medium  
**Affected**: Email outreach conversations page  
**Problem**: After sending an email, there's no delivery status (delivered/bounced/open/clicked) shown in the conversation view. The `emailStatus` field exists on leads but isn't surfaced in outreach.  
**Fix**: Display delivery/open/click badges in the email conversation thread once tracking data is available from Resend webhooks.  
**Expected impact**: Actionable feedback loop for outreach campaigns.

---

### FE-03 — Leads: No Saved Filters / Views
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/leads/page.tsx`  
**Problem**: Leads can be filtered by source, status, date, etc., but filters are lost when navigating away. Power users who segment leads repeatedly (e.g., "LinkedIn leads from last week with email") must re-apply filters every session.  
**Fix**: Add "Save this view" button that persists filter combination to localStorage or user preferences (server-side).  
**Expected impact**: Major time saver for users with consistent segmentation workflows.

---

### FE-04 — Content Studio: No Template Version History
**Severity**: Low  
**Affected**: `client/src/app/dashboard/(main)/content/*`  
**Problem**: When AI generates content or users edit templates, there's no version history. If a user overwrites a good template, they can't recover the previous version.  
**Fix**: Store last 3–5 versions of each content asset. Add a "Version history" dropdown in the template editor.  
**Expected impact**: Reduces anxiety around editing templates, encourages experimentation.

---

### FE-05 — Outreach: No Follow-Up Sequence Builder
**Severity**: High  
**Affected**: Email outreach  
**Problem**: The `startSequence` boolean exists in `SendEmailModal` but there's no visual sequence builder. Users can't define "send email A on day 1, email B on day 3, email C on day 7" without direct API knowledge.  
**Fix**: Build a visual multi-step sequence editor (like a simple timeline) where users define delay + template for each step. Store as a campaign sequence in the DB.  
**Expected impact**: Core feature for sales automation; dramatically increases outreach effectiveness.

---

### FE-06 — Dashboard Home: No Exportable Report
**Severity**: Low  
**Affected**: `client/src/app/dashboard/(main)/home/page.tsx`  
**Problem**: The dashboard has charts and stats (leads trend, conversion funnel, etc.) but no way to export these as a PDF or CSV for sharing with stakeholders.  
**Fix**: Add an "Export" dropdown in the dashboard header that generates a PDF snapshot of current charts.  
**Expected impact**: Enables sales team reporting, increases perceived product value.

---

### FE-07 — Contacts: No Duplicate Detection
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/crm/contacts/page.tsx`, import flow  
**Problem**: When importing contacts via CSV or syncing from leads, duplicate emails are skipped (handled in `syncContactsToLeads`), but there's no UI feedback when duplicates are found during CSV import. The user doesn't know how many duplicates were skipped.  
**Fix**: After import, show a summary: "47 contacts added, 12 duplicates skipped". Link to show the skipped items.  
**Expected impact**: Cleaner contact lists, user confidence in data integrity.

---

## Performance Optimizations

### PERF-01 — WorkflowContext Has 6+ chained useEffect Hooks  
**Severity**: High  
**Affected**: `client/src/contexts/WorkflowContext.tsx`  
**Problem**: Six separate `useEffect` hooks each handle one piece of state synchronization (`incomingEvent`, `messages`, `selectedIcp`, `selectedIcpData`, `selectedStrategy`, `selectedLeads`). Every state change triggers a cascade of re-renders for all consumers of this context.  
**Fix**: Consolidate state updates using `useReducer` with a `dispatch` pattern. Or split the context into separate focused contexts (e.g., `IcpContext`, `LeadSelectionContext`) following the React "context splitting" best practice.  
**Expected impact**: Reduced re-renders; smoother chat interactions when AI is streaming responses.

---

### PERF-02 — home/page.tsx is 1,200+ Lines
**Severity**: Medium  
**Affected**: `client/src/app/dashboard/(main)/home/page.tsx`  
**Problem**: A single 1,200+ line page component handles stats fetching, chart rendering, AI chat interface, profile selection, and onboarding checks. This creates a massive component that re-renders entirely on any state change.  
**Fix**: Extract into sub-components:
- `<DashboardStats />` — stats cards + charts
- `<DashboardAIChat />` — quick chat widget
- `<OnboardingChecklist />` — setup progress

Use `React.memo()` to prevent unnecessary re-renders.  
**Expected impact**: Faster initial render, more targeted re-renders.

---

### PERF-03 — No Bundle Code Splitting for Heavy Libraries
**Severity**: Medium  
**Affected**: Global bundle, ReactFlow (workflow) and ApexCharts usage  
**Problem**: ReactFlow and ApexCharts are heavy libraries. If they're loaded in the main bundle, every dashboard page downloads them even if the user never visits the workflow or analytics pages.  
**Fix**: Use dynamic imports with Next.js `dynamic()`:
```tsx
const WorkflowEditor = dynamic(() => import('@/components/workflow/WorkflowEditor'), {
  loading: () => <Skeleton className="h-96 w-full" />,
  ssr: false,
});
```
**Expected impact**: Reduced initial bundle size of ~300KB+ for non-workflow/chart pages.

---

### PERF-04 — Inconsistent Data Fetching (React Query vs. Raw useEffect)
**Severity**: Medium  
**Affected**: `home/page.tsx` uses React Query; `leads/page.tsx`, `settings/page.tsx` use raw `useState + useEffect`  
**Problem**: Mixed approaches mean some data is cached and deduped (React Query) while other data re-fetches on every mount. Results in unnecessary API calls.  
**Fix**: Standardize on React Query (TanStack Query v5) for all server state. Local UI state (modals, form inputs) stays in `useState`.  
**Expected impact**: Automatic caching, background refetch, and deduplication. Fewer API calls.

---

### PERF-05 — Images Could Use Next.js `<Image>` More Consistently
**Severity**: Low  
**Affected**: Multiple pages using `<img>` tags for logos, avatars  
**Problem**: Some avatar/logo images use plain HTML `<img>` tags instead of Next.js `<Image>` with optimization. This means no lazy loading, no automatic WebP conversion.  
**Fix**: Replace `<img>` with Next.js `<Image>` where CLS (Cumulative Layout Shift) and performance matter. Always include `width`, `height`, and `alt` props.  
**Expected impact**: Improved Core Web Vitals scores (LCP, CLS).

---

### PERF-06 — next.config.ts has Wildcard Image Hostname
**Severity**: Medium (Security + Performance)  
**Affected**: `client/next.config.ts`  
**Problem**: 
```ts
images: {
  remotePatterns: [
    { protocol: "https", hostname: "**" }, // Too permissive
  ],
}
```
This allows ANY HTTPS hostname to serve images through Next.js image optimization. Malicious actors could use this for SSRF-like image proxying.  
**Fix**: Enumerate the specific domains used:
```ts
remotePatterns: [
  { protocol: "https", hostname: "*.linkedin.com" },
  { protocol: "https", hostname: "*.instagram.com" },
  { protocol: "https", hostname: "storage.googleapis.com" },
  // etc.
]
```
**Expected impact**: Security hardening; no functional change for legitimate image sources.

---

## Mobile Responsiveness Issues

### MOB-01 — Dashboard Home Grid Jumps from 4-Column to 1-Column
**Severity**: High  
**Affected**: `client/src/app/dashboard/(main)/home/page.tsx` (line 616)  
**Problem**: 
```tsx
<div className="grid md:grid-cols-4 gap-4">  {/* No sm: breakpoint */}
```
On screens between 375px–768px (phones and small tablets), all 4 stat cards stack into a single column. A 2-column layout would be more readable on mobile.  
**Fix**: 
```tsx
<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
```
**Expected impact**: Usable stat cards on mobile without excessive scrolling.

---

### MOB-02 — Conversation/Chat Layout Breaks on Tablet
**Severity**: High  
**Affected**: Email outreach page (`/dashboard/outreach/email/page.tsx`), chat conversations  
**Problem**: The three-panel layout (leads list → conversations → messages) uses `hidden md:flex` and `hidden lg:flex` classes, but the panel widths are hardcoded (300px). On iPad mini (768px) all three panels try to show simultaneously, making each panel too narrow to be usable.  
**Fix**: Reduce panel widths for `md:` breakpoint or switch to a side-drawer pattern on tablet.  
**Expected impact**: Usable tablet interface for field sales reps.

---

### MOB-03 — Tables Have No Mobile View
**Severity**: High  
**Affected**: CRM contacts table, leads table, settings tables  
**Problem**: Data tables with 7–9 columns overflow horizontally on mobile. The `overflow-x-auto` wrapper creates horizontal scrolling but users must scroll sideways to see all columns — a terrible mobile experience.  
**Fix**: On mobile (`< md:`), switch tables to card-based list views (like the contacts page already does partially). Show only the 2–3 most important fields with a ">" arrow to the detail page.  
**Expected impact**: Fully functional mobile table views instead of horizontal scrolling.

---

### MOB-04 — Sidebar Navigation Lacks Mobile Gestures
**Severity**: Medium  
**Affected**: `client/src/components/DashboardLayout.tsx`  
**Problem**: The sidebar opens/closes via a button click. Mobile users expect swipe-to-open/close gestures for navigation drawers.  
**Fix**: Add touch event handlers (swipe right → open, swipe left → close) using a simple pointer event listener.  
**Expected impact**: Standard mobile UX pattern. Faster navigation on phones.

---

### MOB-05 — Floating Action Buttons Missing on Mobile
**Severity**: Low  
**Affected**: CRM contacts page, leads page  
**Problem**: The "Add Contact" / "Add Lead" buttons are in the top header, which requires scrolling to top on mobile. After scrolling down 20+ rows, there's no quick way to add a new record.  
**Fix**: Add a floating action button (FAB) in the bottom-right corner on mobile, visible when the user has scrolled past the header.  
**Expected impact**: Standard mobile CRM/list UX pattern.

---

## Accessibility Problems

### A11Y-01 — Tables Missing Semantic Markup
**Severity**: Medium  
**Affected**: `LeadsTab.tsx`, CRM contacts table  
**Problem**: Data tables use `div`-based layouts with flex/grid instead of semantic `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>` elements. Screen readers cannot identify column headers or navigate by row.  
**Fix**: Replace flex-based pseudo-tables with semantic HTML tables using `<table>` elements, or use shadcn/ui's `Table` component which includes accessibility props.  
**Expected impact**: Screen reader compatibility; WCAG 2.1 Level AA compliance.

---

### A11Y-02 — Chat Message Bubbles Have No ARIA Labels
**Severity**: Medium  
**Affected**: `client/src/components/ChatInterface.tsx`, `OutreachMessageBubble.tsx`  
**Problem**: AI and user message bubbles are plain `div` elements with no `role` or `aria-label`. Screen reader users hear the text but can't distinguish it's a chat message, who sent it, or the timestamp.  
**Fix**: 
```tsx
<div 
  role="listitem" 
  aria-label={`${message.role === 'assistant' ? 'AI' : 'You'}: ${message.content}`}
/>
```
Use `role="log"` on the message container with `aria-live="polite"` to announce new messages.  
**Expected impact**: Screen reader usability for the core chat feature.

---

### A11Y-03 — Form Error Messages Not Linked to Inputs
**Severity**: Medium  
**Affected**: Settings page, login, register, setup forms  
**Problem**: Error messages appear below inputs but are not linked via `aria-describedby`. Screen readers read the input label and value but not the error message.  
**Fix**: 
```tsx
<Input id="email" aria-describedby="email-error" aria-invalid={!!errors.email} />
<p id="email-error" className="text-destructive text-xs">{errors.email}</p>
```
**Expected impact**: WCAG 2.1 compliance for form errors.

---

### A11Y-04 — Focus Trapping in Modals
**Severity**: Medium  
**Affected**: All dialogs using shadcn/ui `Dialog`  
**Problem**: shadcn/ui's Dialog component includes focus trapping by default via Radix UI. However, custom modal-style overlays (e.g., the full-screen content builder modal) may not trap focus.  
**Fix**: Verify all custom overlays use `FocusTrap` or Radix UI's Dialog component.  
**Expected impact**: Keyboard users won't be able to accidentally tab outside of open modals.

---

### A11Y-05 — Color is the Only Differentiator for Status Badges
**Severity**: Low  
**Affected**: CRM pipeline status badges, lead status badges  
**Problem**: Status badges (e.g., "won" = green, "lost" = red) rely solely on color. Users with color vision deficiency can't distinguish them.  
**Fix**: Add a small icon inside each status badge (e.g., ✓ for won, ✗ for lost, ● for active).  
**Expected impact**: WCAG 2.1 "Use of Color" criterion met.

---

## Production Readiness Issues

### PROD-01 — `@placeholder.lead` Emails in System
**Severity**: High  
**Affected**: `client/src/components/LeadDetailSheet.tsx` (line 81)  
**Problem**: The system checks for `@placeholder.lead` email pattern to determine if a lead's email is "real". This implies at least some test or synthetic leads with placeholder emails are in the production database.
```tsx
available: !!(lead.email && !lead.email.includes('@placeholder.lead')),
```
**Fix**: Audit the production `leads` table for `@placeholder.lead` emails and clean them out. Remove or replace the synthetic leads with real data.  
**Expected impact**: No artificial data visible to real users.

---

### PROD-02 — No Error Boundary at Dashboard Level
**Severity**: High  
**Affected**: All dashboard pages  
**Problem**: If a React component throws an unhandled error during render (e.g., `undefined.name`), the entire dashboard unmounts and shows Next.js's default crash screen. There is no scoped error boundary.  
**Fix**: Wrap each major page section in an `<ErrorBoundary fallback={<SectionError />}>` component. The sidebar and navigation should always remain functional even if a page section crashes.  
**Expected impact**: Graceful degradation instead of full-screen crashes.

---

### PROD-03 — Admin Panel Debug Console.log
**Severity**: Low  
**Affected**: `client/src/app/admin/dashboard/leadflow/Canvas.tsx` (line 86)  
**Problem**: 
```tsx
console.log("[Canvas] InputParametersDialog state changed:", {...});
```
This debug log is in production code and will appear in browser DevTools for anyone inspecting the admin panel.  
**Fix**: Remove the `console.log` statement.  
**Expected impact**: Clean production logs, no accidental data exposure in console.

---

### PROD-04 — React Query StaleTime Not Configured
**Severity**: Medium  
**Affected**: `client/src/lib/query-client.ts` (inferred)  
**Problem**: Without explicit `staleTime` configuration, React Query refetches every query on window focus. In a real-time WebSocket-powered app like AskSales, this causes redundant API calls every time the user switches browser tabs.  
**Fix**: Set `defaultOptions.queries.staleTime = 30_000` (30 seconds) and use WebSocket events to invalidate specific queries on real-time changes.  
**Expected impact**: Reduced API load; no "double fetch" on tab focus.

---

### PROD-05 — Build Produces 3.9MB Server Bundle
**Severity**: Medium  
**Affected**: Server build (`server/dist/index.js`)  
**Problem**: The server esbuild output is a single 3.9MB bundle. While functional, this is large for a Node.js server and suggests some large dependencies might be bundled that should be marked as external.  
**Fix**: Audit `--packages=external` usage and ensure all native Node modules and large SDKs (googleapis, puppeteer) are externalized.  
**Expected impact**: Faster server cold start, easier debugging with smaller bundle.

---

## High Priority Improvements

| # | Item | Impact | Effort |
|---|------|--------|--------|
| 1 | Audit and fix ALL silent catch blocks in dashboard pages | Massive — eliminates main confusion source | Medium |
| 2 | Add Error Boundaries at dashboard + route level | High — prevents full-screen crashes | Low |
| 3 | Fix mobile grid breakpoints (missing sm:) | High — makes app usable on phones | Low |
| 4 | Remove "Activity log coming soon." from Settings | Medium — removes unfinished appearance | Trivial |
| 5 | Remove @placeholder.lead synthetic data from production DB | High — data quality | Low |
| 6 | Fix next.config.ts wildcard hostname (security) | High — security fix | Trivial |
| 7 | Remove console.log from admin Canvas.tsx | Low effort + professional hygiene | Trivial |

---

## Medium Priority Improvements

| # | Item | Impact | Effort |
|---|------|--------|--------|
| 1 | Standardize React Query across all data fetching | Major caching, dedup, simpler code | High |
| 2 | Split home/page.tsx (1200 lines) into sub-components | Better render perf, maintainability | Medium |
| 3 | Add per-lead loading spinners for score/enrich/validate | UX clarity during long operations | Low |
| 4 | Consolidate WorkflowContext useEffects into useReducer | Fewer re-renders in chat | Medium |
| 5 | Build bulk lead actions (select + email/delete/export) | Core power-user feature | Medium |
| 6 | Dynamic import ReactFlow and ApexCharts | Reduced bundle, faster first load | Low |
| 7 | Replace hardcoded CHART_COLORS with CSS variables | Theme consistency, dark mode | Low |
| 8 | Add drag-and-drop to CRM pipeline board | Modern CRM UX expectation | Medium |

---

## Low Priority Improvements

| # | Item | Impact | Effort |
|---|------|--------|--------|
| 1 | Keyboard shortcuts / command palette (⌘K) | Power user productivity | High |
| 2 | Add swipe gestures on mobile sidebar | Mobile UX polish | Low |
| 3 | Template version history in Content Studio | Safety net for content editing | Medium |
| 4 | Export dashboard as PDF | Reporting / stakeholder sharing | Medium |
| 5 | Inline table editing (double-click to edit) | Reduced clicks for CRM updates | Medium |
| 6 | Accessibility: ARIA labels on chat messages | WCAG compliance | Low |
| 7 | Accessibility: Link error messages via aria-describedby | WCAG compliance forms | Low |
| 8 | Semantic HTML tables instead of flex pseudo-tables | Screen reader support | Medium |

---

## Quick Wins

These fixes take under 1 hour each and have immediate visible impact:

1. **Remove "Activity log coming soon."** — 1 line change in settings/page.tsx
2. **Remove console.log in Canvas.tsx** — 1 line deletion
3. **Fix next.config.ts image wildcard** — Replace `"**"` with specific domains
4. **Add `sm:grid-cols-2`** to all stat card grids — Instant mobile improvement
5. **Replace "Loading..." text** in sidebar thread loading with Skeleton — matches existing patterns
6. **Add toast to catch blocks in home/page.tsx** — 5 blocks, 5 toast calls
7. **Remove `@placeholder.lead` synthetic data** from production database

---

## Recommended UI Refactors

### R-UI-01: Design Token Centralization
Move all chart colors, spacing constants, and repeated color values into `tailwind.config.ts` as CSS custom properties. Eliminates the hardcoded hex scattered across 10+ components.

### R-UI-02: Empty State Component
Create a shared `<EmptyState icon={} title={} description={} cta={} />` component used everywhere. Currently each page implements its own empty state pattern inconsistently.

### R-UI-03: Status Badge Component
Create a shared `<StatusBadge status="won" />` component that maps status → color + icon + label. Replaces the `STATUS_COLORS` record duplicated in contacts/page.tsx and other CRM pages.

### R-UI-04: Page Header Component
Create a standard `<PageHeader title={} subtitle={} actions={} />` component. Currently every page implements its own header layout with varying heights, icon sizes, and button arrangements.

---

## Recommended UX Refactors

### R-UX-01: Global Error Recovery Pattern
Define a standard error recovery pattern for the entire app:
- Network error → Toast + "Try again" button
- 401 → Redirect to login (already handled)
- 429 → Toast "Too many requests, please wait"
- 500 → Toast + link to status page

Implement as an API client interceptor, not in each catch block.

### R-UX-02: Optimistic Updates
For quick actions (marking a lead as contacted, updating pipeline status, toggling reminder done), apply the change immediately in UI before the API confirms. Revert on error. This eliminates the "click + wait" pattern.

### R-UX-03: Persistent Filters
Save applied lead filters to `sessionStorage` so they survive page refreshes. Store to `localStorage` for saved views. Use URL query params for shareable filter states.

---

## Competitive-Level Feature Suggestions

These are features that comparable SaaS tools (HubSpot, Apollo, Clerk, Notion) offer that would bring AskSales.ai up to modern expectations:

| Feature | Comparable Product | Value |
|---------|-------------------|-------|
| Unified inbox (email + WhatsApp + Instagram in one feed) | HubSpot Conversations | Cross-channel visibility |
| Smart contact deduplication with merge UI | Salesforce, HubSpot | Data quality |
| AI-powered email subject line suggestions | Lavender, Apollo | Better open rates |
| Contact enrichment auto-run on import | Apollo, Cognism | Saves manual work |
| Outreach A/B testing for subject lines | Mailchimp, Apollo | Data-driven optimization |
| Meeting scheduler embedded in outreach | Calendly-style button in email | Reduced friction |
| Deal scoring with explanation ("Why 78%?") | Salesforce Einstein | User trust in AI |
| Saved search queries for leads | LinkedIn Sales Navigator | Repeatable workflows |
| Mobile app / PWA | HubSpot CRM mobile | Field sales use case |

> Note: These are suggestions aligned with the platform's current direction. Not all may be relevant to the current roadmap.

---

## Final Product Quality Score

| Dimension | Score | Notes |
|-----------|-------|-------|
| Core Functionality | 8/10 | Feature-complete; minor bugs fixed in this sprint |
| UI Polish | 6/10 | Good components, inconsistent spacing/radius/empty states |
| UX Flow | 5/10 | Silent errors and missing feedback are critical gaps |
| Mobile Usability | 4/10 | Needs significant responsive improvements |
| Accessibility | 4/10 | Basic structure ok, semantic HTML and ARIA labels missing |
| Performance | 6/10 | React Query inconsistency, large components, no lazy loading for heavy libs |
| Production Readiness | 6/10 | Placeholder content, missing error boundaries, debug logs |
| Code Maintainability | 7/10 | Good patterns when used consistently |
| **Overall** | **5.75/10** | **Good foundation; focused polish sprint needed before wide launch** |

---

## Appendix: Files Requiring Most Attention

| File | Lines | Issues |
|------|-------|--------|
| `client/src/app/dashboard/(main)/home/page.tsx` | 1200+ | Silent errors, hardcoded colors, large component |
| `client/src/app/dashboard/(main)/leads/page.tsx` | 500+ | 5 silent catch blocks, missing per-lead feedback |
| `client/src/components/ChatInterface.tsx` | 500+ | 15+ prop drilling, no aria labels |
| `client/src/contexts/WorkflowContext.tsx` | ~300 | 6+ useEffect chains |
| `client/src/components/DashboardLayout.tsx` | 500+ | hardcoded rootPaths, text-only loading |
| `client/next.config.ts` | 30 | wildcard hostname security gap |
| `client/src/app/dashboard/(main)/settings/page.tsx` | ~400 | "coming soon" placeholder visible |
