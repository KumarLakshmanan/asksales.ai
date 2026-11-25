"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface PaginationProps {
  /** 1-based current page. Out-of-range values are clamped for display. */
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  /** Show the page-size picker by passing this handler. */
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: readonly number[]
  /** Plural noun for the range summary: "Showing 1–25 of 140 leads". */
  itemLabel?: string
  /** Disable every control, e.g. while the next page loads. */
  disabled?: boolean
  /** Show first/last page buttons (hidden on narrow screens either way). */
  showEdgeButtons?: boolean
  /** Names the navigation landmark; set it when a page has more than one paginator. */
  "aria-label"?: string
  className?: string
}

/** The numbers behind the summary; exported so tables and tests share one calculation. */
export function getPaginationRange(page: number, pageSize: number, totalItems: number) {
  const safeSize = Math.max(1, Math.floor(pageSize) || 1)
  const total = Math.max(0, Math.floor(totalItems) || 0)
  const totalPages = Math.max(1, Math.ceil(total / safeSize))
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const from = total === 0 ? 0 : (current - 1) * safeSize + 1
  const to = Math.min(current * safeSize, total)
  return { current, totalPages, from, to, total }
}

const numberFormat = new Intl.NumberFormat()

/**
 * Page controls for server- or client-paginated lists: range summary,
 * optional page-size picker, and previous/next (plus first/last) buttons.
 */
export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  itemLabel = "results",
  disabled = false,
  showEdgeButtons = true,
  "aria-label": ariaLabel = "Pagination",
  className,
}: PaginationProps) {
  const { current, totalPages, from, to, total } = getPaginationRange(page, pageSize, totalItems)
  const atStart = current <= 1
  const atEnd = current >= totalPages

  const go = (target: number) => {
    const next = Math.min(Math.max(1, target), totalPages)
    if (next !== current) onPageChange(next)
  }

  // Include the current size even if a caller passes one not in the list.
  const sizes = pageSizeOptions.includes(pageSize)
    ? pageSizeOptions
    : [...pageSizeOptions, pageSize].sort((a, b) => a - b)

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-sm text-muted-foreground" aria-live="polite" aria-atomic="true">
        {total === 0 ? (
          <>No {itemLabel}</>
        ) : (
          <>
            Showing <span className="font-medium text-foreground tabular-nums">{numberFormat.format(from)}</span>–
            <span className="font-medium text-foreground tabular-nums">{numberFormat.format(to)}</span> of{" "}
            <span className="font-medium text-foreground tabular-nums">{numberFormat.format(total)}</span> {itemLabel}
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange ? (
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 w-[116px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <div className="flex items-center gap-1">
          {showEdgeButtons ? (
            <Button
              variant="outline"
              size="icon-sm"
              className="hidden sm:inline-flex"
              aria-label="First page"
              disabled={disabled || atStart}
              onClick={() => go(1)}
            >
              <ChevronsLeft aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={disabled || atStart}
            onClick={() => go(current - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="min-w-[96px] px-1 text-center text-sm tabular-nums text-muted-foreground">
            Page {numberFormat.format(current)} of {numberFormat.format(totalPages)}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={disabled || atEnd}
            onClick={() => go(current + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          {showEdgeButtons ? (
            <Button
              variant="outline"
              size="icon-sm"
              className="hidden sm:inline-flex"
              aria-label="Last page"
              disabled={disabled || atEnd}
              onClick={() => go(totalPages)}
            >
              <ChevronsRight aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </nav>
  )
}
