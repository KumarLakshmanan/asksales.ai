# Shared UI components

Primitives in this folder are shadcn/Radix based. This guide covers the composite
components built on top of them for the patterns the app repeats most: loading
indicators, search fields, pagination, KPI tiles, file pickers and data tables.

Live examples, including every loading, error and empty state, are at
**`/dev/ui-kit`** (`src/app/dev/ui-kit`). The route returns 404 in production builds.

## Architecture

```
Spinner ──────────────┐
Button (loading) ─────┼──► SearchInput   (spinner while results load)
Skeleton ─────────────┤    Pagination    (Button + Select)
Checkbox ─────────────┤    StatCard / StatGrid (Skeleton)
Table primitives ─────┘    FileDropzone  (Spinner, formatBytes)
                           DataTable     (Table, Checkbox, Skeleton, Button)
                           LoadingState  (Spinner)
                           CopyButton    (Button)
                           DescriptionList (Skeleton)
Semantic colour tokens ──► Callout, StatusBadge
```

Conventions every component follows:

- **Each layer owns one job.** Components render state; they never fetch. Callers pass
  `loading`, `error` and data, so the same component works with React Query, server
  pagination or local arrays.
- **Loading keeps the layout still.** Skeletons take the same footprint as the content,
  refetches dim the content instead of replacing it, and a busy Button keeps its focus
  and width.
- **Accessible names are required props** where a placeholder or an icon would
  otherwise be the only label (`SearchInput aria-label`, `DataTable caption`).
- **Pure logic is exported** (`validateFiles`, `sortRows`, `getPaginationRange`), so
  it can be unit-tested and reused without rendering anything.
- **Escape hatches:** every component accepts `className`, and the slot props
  (`emptyState`, `footer`, `hint`, `label`) take any `ReactNode`.

## Spinner — `spinner.tsx`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `"xs" \| "sm" \| "md" \| "lg" \| "xl"` | `"sm"` | 14px to 32px |
| `label` | `string \| null` | `"Loading"` | Screen-reader text. `null` = decorative (inside something already busy) |

```tsx
<Spinner />                            // role="status", announces "Loading"
<Spinner size="xl" label="Loading report" />
<Spinner label={null} />               // purely visual
```

Use this instead of `<Loader2 className="h-4 w-4 animate-spin" />`.

## Button `loading` — `button.tsx`

The existing Button gains two optional props. Nothing changes for current callers.

| Prop | Type | Notes |
| --- | --- | --- |
| `loading` | `boolean` | Spinner, `aria-busy`, ignores clicks and form submits, **stays focusable** |
| `loadingText` | `ReactNode` | Label while loading; defaults to the normal label |

```tsx
<Button loading={mutation.isPending} loadingText="Saving…" onClick={save}>Save changes</Button>
<Button size="icon" aria-label="Download" loading={downloading}><Download /></Button>
```

With `asChild`, only `aria-busy` is applied, because Slot requires exactly one child.

## SearchInput — `search-input.tsx`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `aria-label` | `string` | required | A placeholder is not a label |
| `value` / `defaultValue` | `string` | | Controlled or uncontrolled |
| `onValueChange` | `(value) => void` | | Every keystroke, raw |
| `onSearch` | `(query) => void` | | Trimmed and debounced; fires immediately on Enter or clear; never fires twice for the same query |
| `debounceMs` | `number` | `300` | `0` = every change |
| `loading` | `boolean` | `false` | Spinner replaces the clear button |
| `size` | `"sm" \| "default"` | `"default"` | |
| `wrapperClassName` | `string` | | Width or margins of the wrapper; `className` styles the input |

Escape clears the text. When the field is already empty, Escape propagates so it can
still close a dialog. A controlled reset from the parent (e.g. "Clear filters") does
not emit a duplicate `onSearch`.

```tsx
<SearchInput
  aria-label="Search leads by name or company"
  placeholder="Search leads…"
  loading={query.isFetching}
  onSearch={(q) => { setSearch(q); setPage(1); }}
/>
```

## Pagination — `pagination.tsx`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | `number` | required | 1-based; out-of-range values are clamped |
| `pageSize`, `totalItems` | `number` | required | |
| `onPageChange` | `(page) => void` | required | Never called with the current page |
| `onPageSizeChange` | `(size) => void` | | Passing it shows the page-size picker |
| `pageSizeOptions` | `number[]` | `[10, 25, 50, 100]` | The current size is added if missing |
| `itemLabel` | `string` | `"results"` | "Showing 1–25 of 140 **leads**" |
| `disabled` | `boolean` | `false` | E.g. while the next page loads |
| `showEdgeButtons` | `boolean` | `true` | First/last buttons; hidden below `sm` |
| `aria-label` | `string` | `"Pagination"` | Set it when a page has more than one paginator |

```tsx
<Pagination
  page={page} pageSize={pageSize} totalItems={data?.total ?? 0}
  onPageChange={setPage}
  onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
  itemLabel="users" disabled={isFetching}
/>
```

## StatCard / StatGrid — `stat-card.tsx`

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `ReactNode` | Required |
| `value` | `ReactNode` | Pre-formatted. `null`/`undefined` shows `emptyValue` (default "—"), so missing data never reads as 0 |
| `delta` | `{ value, trend: "up" \| "down" \| "flat", positiveDirection?: "up" \| "down" \| "none", label? }` | The colour follows whether the change is good; the direction is also spoken |
| `description`, `icon`, `footer` | `ReactNode` | |
| `loading` | `boolean` | Skeleton in the same footprint |
| `tone` | `"neutral" \| "primary" \| "success" \| "warning" \| "destructive"` | |

`StatGrid columns={2|3|4|5}` gives 1 column on phones, 2 on tablets, and N on wide screens.

```tsx
<StatGrid columns={4}>
  <StatCard label="Leads" value={fmt(total)} loading={isLoading}
    delta={{ value: "12%", trend: "up", label: "vs last week" }} />
  <StatCard label="Cost per lead" value="₹312"
    delta={{ value: "9%", trend: "down", positiveDirection: "down" }} />
</StatGrid>
```

## FileDropzone — `file-dropzone.tsx`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `onFilesAccepted` | `(files: File[]) => void` | required | Never called with an empty list |
| `onFilesRejected` | `(rejections: FileRejection[]) => void` | | `reason`: `file-type`, `file-too-large`, `file-empty`, `too-many-files` |
| `accept` | `string` | | Same syntax as `<input accept>`; also enforced on drop |
| `maxSize` | `number` (bytes) | | |
| `multiple`, `maxFiles` | `boolean`, `number` | `false` | |
| `loading`, `loadingText` | `boolean`, `ReactNode` | `"Uploading…"` | Blocks new files |
| `error` | `ReactNode` | | External error, e.g. a failed upload |
| `label`, `hint` | `ReactNode` | generated | Hint is built from `accept`/`maxSize`, e.g. "CSV, XLSX · up to 5 MB each" |
| `compact` | `boolean` | `false` | Single-line layout for side panels |
| `showRejections` | `boolean` | `true` | Set `false` to render rejections yourself |

The picker is a real file input, visually hidden inside a `<label>`, so Tab, Enter and
Space and screen readers get the native behaviour. Hints and errors are linked with
`aria-describedby`, and the input value is reset so the same file can be picked again.

```tsx
<FileDropzone
  accept=".csv,.xlsx" maxSize={5 * 1024 * 1024}
  loading={upload.isPending} error={upload.error?.message}
  onFilesAccepted={([file]) => upload.mutate(file)}
/>
```

`validateFiles(files, options)` applies the same rules outside the component, for
example to files pasted into an editor.

## DataTable — `data-table.tsx`

Typed with the row type: `DataTable<Lead>`.

**Columns** (`DataTableColumn<T>`):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Stable key |
| `header` | `ReactNode` | |
| `cell` | `(row, index) => ReactNode` | |
| `sortValue` | `(row) => string \| number \| Date \| boolean \| null` | Makes the column sortable. Empty values always sort last; strings compare naturally and ignore case |
| `align` | `"left" \| "center" \| "right"` | Right-aligned cells use tabular numerals |
| `hideBelow` | `"sm" \| "md" \| "lg" \| "xl"` | Drops low-priority columns on small screens |
| `className`, `headerClassName` | `string` | |

**Table props:**

| Prop | Notes |
| --- | --- |
| `data` | `undefined` = not loaded (skeleton rows); `[]` = loaded and empty (`emptyState`) |
| `getRowId`, `caption` | Required. The caption is screen-reader-only unless `showCaption` |
| `loading` | First load shows skeletons; a refetch dims the existing rows and sets `aria-busy` |
| `error`, `onRetry` | Replaces the body with an alert and a "Try again" button |
| `sort`, `onSortChange`, `manualSorting` | Uncontrolled by default; control it for URL state; `manualSorting` for server-sorted data. Clicking cycles asc → desc → off |
| `selectedRowIds`, `onSelectedRowIdsChange`, `getRowSelectionLabel`, `isRowSelectable` | Passing both of the first two adds a checkbox column with an indeterminate select-all |
| `onRowClick`, `getRowLabel` | Clickable rows reachable by Tab and Enter. Clicks on buttons, links and checkboxes inside a row are ignored |
| `density` | `"default" \| "compact"` |

```tsx
const columns: DataTableColumn<Lead>[] = [
  { id: "name", header: "Lead", sortValue: (l) => l.name, cell: (l) => l.name },
  { id: "company", header: "Company", hideBelow: "md", cell: (l) => l.company },
  { id: "score", header: "Score", align: "right", sortValue: (l) => l.score, cell: (l) => l.score ?? "—" },
];

<DataTable
  caption="Leads"
  columns={columns}
  data={query.data?.rows}
  getRowId={(l) => l.id}
  loading={query.isFetching}
  error={query.error ? "We couldn’t load leads." : undefined}
  onRetry={() => query.refetch()}
  selectedRowIds={selected}
  onSelectedRowIdsChange={setSelected}
  getRowSelectionLabel={(l) => `Select ${l.name}`}
  onRowClick={openLeadSheet}
  getRowLabel={(l) => `Open ${l.name}`}
  emptyState={<PageEmptyState compact title="No leads yet" />}
/>
```

Define `columns` outside the component, or wrap it in `useMemo`, so client-side sorting
does not re-run on every render.

## LoadingState — `loading-state.tsx`

A centred spinner for a page or section that has nothing to show yet. Prefer a
skeleton when you know the shape of the coming content.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `"page" \| "section" \| "inline"` | `"section"` | `page` fills 60vh; `section` pads 48px; `inline` for rows |
| `label` | `string` | `"Loading…"` | Always announced. Say what is loading |
| `showLabel` | `boolean` | `false` | Also show the label under the spinner |

```tsx
if (isLoading) return <LoadingState size="page" label="Loading campaigns…" />;
```

## Callout — `callout.tsx`

An inline message that belongs to part of the page. Use a toast for transient
results and `PageErrorState` for whole-page failures.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `tone` | `"info" \| "success" \| "warning" \| "danger" \| "neutral"` | `"info"` | Uses the theme's semantic tokens, so it works in both themes |
| `title` | `ReactNode` | | |
| `children` | `ReactNode` | | The message |
| `actions` | `ReactNode` | | Buttons or links under the message |
| `onDismiss`, `dismissLabel` | `() => void`, `string` | | Adds a labelled close button |
| `icon` | `LucideIcon \| false` | tone icon | |
| `size` | `"default" \| "sm"` | `"default"` | |
| `announce` | `boolean` | `true` for danger | `role="alert"` for danger, `role="status"` otherwise. Turn it off for messages present on first render |

```tsx
<Callout tone="danger" title="Gmail disconnected"
  actions={<Button size="sm" onClick={reconnect}>Reconnect</Button>}>
  Replies stopped syncing at 10:42.
</Callout>
```

## CopyButton — `copy-button.tsx`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `value` | `string \| () => string \| Promise<string>` | required | A function delays work until the user clicks |
| `label`, `copiedLabel`, `errorLabel` | `string` | `"Copy"`, `"Copied"`, `"Couldn’t copy"` | Shown in place, and announced |
| `iconOnly` | `boolean` | `false` | The label becomes the accessible name |
| `onCopied`, `onError` | `() => void` | | |
| …`ButtonProps` | | `variant="outline"` | |

It falls back to `execCommand("copy")` outside secure contexts, such as a plain-HTTP
staging host. For custom UI, `useCopyToClipboard()` returns `{ status, copy }` and
`copyText(text)` is the bare helper.

```tsx
<CopyButton value={apiKey} label="Copy API key" />
<CopyButton value={embedSnippet} iconOnly label="Copy embed code" />
```

## DescriptionList — `description-list.tsx`

Semantic `<dl>` label/value pairs for record details.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `items` | `{ id?, label, value?, hint?, fullWidth? }[]` | required | A blank `value` renders `emptyValue` |
| `layout` | `"grid" \| "inline"` | `"grid"` | `grid` stacks the label above the value in columns; `inline` puts the label left and the value right |
| `columns` | `1 \| 2 \| 3` | `2` | Grid only; phones always use 1 |
| `loading` | `boolean` | `false` | Skeleton values |
| `emptyValue` | `ReactNode` | `"—"` | |

```tsx
<DescriptionList items={[
  { label: "Company", value: lead.company },
  { label: "Phone", value: lead.phone },
  { label: "Notes", value: lead.notes, fullWidth: true },
]} />
```

## StatusBadge — `status-badge.tsx`

One shared map from status word to meaning, so `failed` is red and `scheduled` is
blue on every screen. Unknown statuses are neutral. The text always states the
status; colour is never the only signal, and it is carried by the dot and tint
so small text keeps AA contrast.

| Prop | Type | Notes |
| --- | --- | --- |
| `status` | `string \| null` | Raw API value; case and `-`/`_`/space are ignored |
| `label` | `ReactNode` | Defaults to the humanised status ("in_progress" → "In progress") |
| `tone` | `"neutral" \| "info" \| "success" \| "warning" \| "danger" \| "progress"` | Skip the lookup |
| `toneOverrides` | `Record<string, StatusTone>` | Per-screen meaning, e.g. `{ draft: "info" }` |
| `dot` | `boolean` | Default `true`; pulses for `progress` (not under reduced motion) |

`getStatusTone(status)` and `formatStatusLabel(status)` are exported for tables and filters.

```tsx
<StatusBadge status={campaign.status} />
<StatusBadge status={run.state} label={`Retrying (${run.attempt}/3)`} />
```

## Tests

`src/__tests__/uiKitComponents.test.tsx` and `src/__tests__/uiKitComponents2.test.tsx`
cover the behaviour described above. Run them with:

```bash
npx vitest run src/__tests__/uiKitComponents.test.tsx src/__tests__/uiKitComponents2.test.tsx
```
