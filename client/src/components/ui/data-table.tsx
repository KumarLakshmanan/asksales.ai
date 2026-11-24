"use client"

import * as React from "react"
import { AlertCircle, ArrowDown, ArrowUp, ChevronsUpDown, Inbox, RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type SortDirection = "asc" | "desc"
export interface SortState {
  columnId: string
  direction: SortDirection
}

type SortValue = string | number | Date | boolean | null | undefined

export interface DataTableColumn<T> {
  /** Stable key, used for sorting and React keys. */
  id: string
  header: React.ReactNode
  /** Renders the cell. */
  cell: (row: T, rowIndex: number) => React.ReactNode
  /**
   * Makes the column sortable. With client-side sorting the table uses this
   * to order rows; with `manualSorting` it only marks the header as clickable.
   */
  sortValue?: (row: T) => SortValue
  align?: "left" | "center" | "right"
  /** Drop low-priority columns on narrow screens instead of forcing a sideways scroll. */
  hideBelow?: "sm" | "md" | "lg" | "xl"
  /** Applied to both header and body cells (widths, truncation). */
  className?: string
  headerClassName?: string
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[]
  /** `undefined` means “not loaded yet”; an empty array means “loaded, nothing to show”. */
  data: readonly T[] | undefined
  getRowId: (row: T) => string
  /** Describes the table for screen readers. Visually hidden unless `showCaption`. */
  caption: string
  showCaption?: boolean

  /** First load shows skeleton rows; a refetch keeps rows visible and dims them. */
  loading?: boolean
  skeletonRows?: number
  /** When set, replaces the body with an error message and an optional retry. */
  error?: React.ReactNode
  onRetry?: () => void
  /** Shown when `data` is an empty array. Use PageEmptyState for a richer message. */
  emptyState?: React.ReactNode

  /** Controlled sort. Omit both to let the table manage sorting itself. */
  sort?: SortState | null
  onSortChange?: (sort: SortState | null) => void
  /** Rows already arrive sorted (server-side); the table only reports sort changes. */
  manualSorting?: boolean

  /** Enables a checkbox column. Ids refer to `getRowId`. */
  selectedRowIds?: ReadonlySet<string>
  onSelectedRowIdsChange?: (ids: Set<string>) => void
  /** Label for a row's checkbox, e.g. (row) => `Select ${row.name}`. */
  getRowSelectionLabel?: (row: T) => string
  isRowSelectable?: (row: T) => boolean

  /**
   * Makes rows clickable and reachable with Tab/Enter. Prefer a link in the
   * first cell when the row opens a page; use this for drawers and sheets.
   */
  onRowClick?: (row: T) => void
  /** Accessible name for a clickable row, e.g. (row) => `Open ${row.name}`. */
  getRowLabel?: (row: T) => string

  density?: "default" | "compact"
  className?: string
}

const hideBelowClass: Record<NonNullable<DataTableColumn<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
}
const alignClass = { left: "text-left", center: "text-center", right: "text-right" } as const

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

const isEmpty = (value: SortValue) => value === null || value === undefined || value === ""

function compareValues(a: SortValue, b: SortValue) {
  const aEmpty = isEmpty(a)
  const bEmpty = isEmpty(b)
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  return collator.compare(String(a), String(b))
}

/** Stable client-side sort with the same rules the table uses. */
export function sortRows<T>(rows: readonly T[], columns: readonly DataTableColumn<T>[], sort: SortState | null) {
  const column = sort ? columns.find((c) => c.id === sort.columnId) : undefined
  if (!sort || !column?.sortValue) return rows
  const accessor = column.sortValue
  const factor = sort.direction === "asc" ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, value: accessor(row) }))
    .sort((a, b) => {
      // Empty values stay at the bottom in both directions, so only flip real comparisons.
      const result = compareValues(a.value, b.value) * (isEmpty(a.value) || isEmpty(b.value) ? 1 : factor)
      return result || a.index - b.index
    })
    .map((entry) => entry.row)
}

function nextSort(current: SortState | null, columnId: string): SortState | null {
  if (!current || current.columnId !== columnId) return { columnId, direction: "asc" }
  if (current.direction === "asc") return { columnId, direction: "desc" }
  return null
}

const interactiveSelector = "a, button, input, select, textarea, label, [role=button], [role=checkbox], [role=menuitem], [contenteditable=true]"

/**
 * Generic, typed table with sorting, selection, clickable rows and built-in
 * loading, error and empty states. Composes the `Table` primitives, so it
 * matches every other table in the app.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  caption,
  showCaption = false,
  loading = false,
  skeletonRows = 5,
  error,
  onRetry,
  emptyState,
  sort: controlledSort,
  onSortChange,
  manualSorting = false,
  selectedRowIds,
  onSelectedRowIdsChange,
  getRowSelectionLabel,
  isRowSelectable,
  onRowClick,
  getRowLabel,
  density = "default",
  className,
}: DataTableProps<T>) {
  const [internalSort, setInternalSort] = React.useState<SortState | null>(null)
  const sort = controlledSort !== undefined ? controlledSort : internalSort

  const changeSort = (columnId: string) => {
    const next = nextSort(sort, columnId)
    if (controlledSort === undefined) setInternalSort(next)
    onSortChange?.(next)
  }

  const rows = React.useMemo(
    () => (data ? (manualSorting ? data : sortRows(data, columns, sort)) : []),
    [data, columns, sort, manualSorting],
  )

  const selectable = Boolean(selectedRowIds && onSelectedRowIdsChange)
  const hasError = error !== undefined && error !== null && error !== false
  // Select-all only covers rows the user can actually see.
  const selectableIds = React.useMemo(
    () => (selectable && !hasError ? rows.filter((row) => isRowSelectable?.(row) ?? true).map(getRowId) : []),
    [selectable, hasError, rows, isRowSelectable, getRowId],
  )
  const selectedOnPage = selectableIds.filter((id) => selectedRowIds?.has(id)).length
  const headerChecked: boolean | "indeterminate" =
    selectedOnPage === 0 ? false : selectedOnPage === selectableIds.length ? true : "indeterminate"

  const toggleAll = () => {
    if (!selectedRowIds || !onSelectedRowIdsChange) return
    const next = new Set(selectedRowIds)
    if (headerChecked === true) selectableIds.forEach((id) => next.delete(id))
    else selectableIds.forEach((id) => next.add(id))
    onSelectedRowIdsChange(next)
  }
  const toggleRow = (id: string) => {
    if (!selectedRowIds || !onSelectedRowIdsChange) return
    const next = new Set(selectedRowIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectedRowIdsChange(next)
  }

  const columnCount = columns.length + (selectable ? 1 : 0)
  const cellPadding = density === "compact" ? "py-2" : "py-3"
  const isInitialLoad = loading && data === undefined
  const isRefetching = loading && data !== undefined

  const renderBodyMessage = (content: React.ReactNode) => (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columnCount} className="p-0">
        {content}
      </TableCell>
    </TableRow>
  )

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-xl border bg-card transition-opacity",
        isRefetching && "opacity-70",
        className,
      )}
    >
      <Table aria-busy={loading || undefined}>
        <caption className={cn(showCaption ? "px-3 py-2 text-left text-sm text-muted-foreground" : "sr-only")}>
          {caption}
          {loading ? <span className="sr-only">, loading</span> : null}
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selectable ? (
              <TableHead className="w-10">
                <Checkbox
                  checked={headerChecked}
                  onCheckedChange={toggleAll}
                  disabled={selectableIds.length === 0 || isInitialLoad}
                  aria-label={headerChecked === true ? "Deselect all rows" : "Select all rows"}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => {
              const sortable = Boolean(column.sortValue)
              const active = sort?.columnId === column.id
              const direction = active ? sort?.direction : undefined
              const SortIcon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ChevronsUpDown
              return (
                <TableHead
                  key={column.id}
                  scope="col"
                  aria-sort={sortable ? (direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none") : undefined}
                  className={cn(
                    alignClass[column.align ?? "left"],
                    column.hideBelow && hideBelowClass[column.hideBelow],
                    column.className,
                    column.headerClassName,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => changeSort(column.id)}
                      className={cn(
                        "-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active && "text-foreground",
                        column.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {column.header}
                      <SortIcon className={cn("size-3.5", !active && "opacity-50")} aria-hidden="true" />
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>

        <TableBody>
          {hasError
            ? renderBodyMessage(
                <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                  <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                    <AlertCircle className="size-5" aria-hidden="true" />
                  </span>
                  <div className="max-w-sm text-sm text-muted-foreground">{error}</div>
                  {onRetry ? (
                    <Button variant="outline" size="sm" onClick={onRetry} loading={loading}>
                      <RefreshCw aria-hidden="true" />
                      Try again
                    </Button>
                  ) : null}
                </div>,
              )
            : isInitialLoad
              ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <TableRow key={`skeleton-${rowIndex}`} aria-hidden="true" className="hover:bg-transparent">
                    {selectable ? (
                      <TableCell className={cellPadding}>
                        <Skeleton className="size-4" />
                      </TableCell>
                    ) : null}
                    {columns.map((column, columnIndex) => (
                      <TableCell
                        key={column.id}
                        className={cn(cellPadding, column.hideBelow && hideBelowClass[column.hideBelow])}
                      >
                        <Skeleton
                          className={cn(
                            "h-4",
                            // Vary widths so the placeholder reads as text, not a grid of bars.
                            ["w-3/4", "w-1/2", "w-2/3", "w-1/3"][(rowIndex + columnIndex) % 4],
                            column.align === "right" && "ml-auto",
                          )}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.length === 0
                ? renderBodyMessage(
                    emptyState ?? (
                      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                        <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
                        <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
                      </div>
                    ),
                  )
                : rows.map((row, rowIndex) => {
                    const id = getRowId(row)
                    const isSelected = selectedRowIds?.has(id) ?? false
                    const canSelect = isRowSelectable?.(row) ?? true
                    const clickable = Boolean(onRowClick)
                    return (
                      <TableRow
                        key={id}
                        data-state={isSelected ? "selected" : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        aria-label={clickable ? getRowLabel?.(row) : undefined}
                        onClick={
                          clickable
                            ? (event) => {
                                // Let buttons, links and checkboxes inside the row do their own thing.
                                if ((event.target as HTMLElement).closest(interactiveSelector)) return
                                onRowClick?.(row)
                              }
                            : undefined
                        }
                        onKeyDown={
                          clickable
                            ? (event) => {
                                if (event.target !== event.currentTarget) return
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault()
                                  onRowClick?.(row)
                                }
                              }
                            : undefined
                        }
                        className={cn(
                          clickable &&
                            "cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        )}
                      >
                        {selectable ? (
                          <TableCell className={cellPadding}>
                            <Checkbox
                              checked={isSelected}
                              disabled={!canSelect}
                              onCheckedChange={() => toggleRow(id)}
                              aria-label={getRowSelectionLabel?.(row) ?? `Select row ${rowIndex + 1}`}
                            />
                          </TableCell>
                        ) : null}
                        {columns.map((column) => (
                          <TableCell
                            key={column.id}
                            className={cn(
                              cellPadding,
                              alignClass[column.align ?? "left"],
                              column.align === "right" && "tabular-nums",
                              column.hideBelow && hideBelowClass[column.hideBelow],
                              column.className,
                            )}
                          >
                            {column.cell(row, rowIndex)}
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })}
        </TableBody>
      </Table>
    </div>
  )
}
