"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** Calendar days as `YYYY-MM-DD`, both included. */
export interface DateRange {
  from: string
  to: string
}

export type DateRangePreset = "today" | "last7" | "last30" | "thisMonth" | "next7" | "next30"

const presetLabels: Record<DateRangePreset, string> = {
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  thisMonth: "This month",
  next7: "Next 7 days",
  next30: "Next 30 days",
}

/** A date as the `YYYY-MM-DD` the person sees on their own calendar. */
export function toDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number)
  return toDateValue(new Date(year, month - 1, day + days))
}

/** Number of days a range covers, counting both ends. */
export function dateRangeLength(range: DateRange) {
  const at = (value: string) => {
    const [year, month, day] = value.split("-").map(Number)
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((at(range.to) - at(range.from)) / 86_400_000) + 1
}

/** The dates a preset covers, relative to `today`. Exported so callers and tests share one calculation. */
export function presetDateRange(preset: DateRangePreset, today: string = toDateValue(new Date())): DateRange {
  switch (preset) {
    case "today": return { from: today, to: today }
    case "last7": return { from: addDays(today, -6), to: today }
    case "last30": return { from: addDays(today, -29), to: today }
    case "thisMonth": return { from: `${today.slice(0, 8)}01`, to: today }
    case "next7": return { from: today, to: addDays(today, 6) }
    case "next30": return { from: today, to: addDays(today, 29) }
  }
}

export interface DateRangeFieldProps {
  value: DateRange
  onChange: (range: DateRange) => void
  /** Quick choices, in the order shown. "Custom dates" is always added last. */
  presets?: readonly DateRangePreset[]
  /** Longest range allowed; a longer custom range shows a message instead of being applied. */
  maxDays?: number
  /** Names the control for screen readers, e.g. "Dates for this chart". */
  "aria-label"?: string
  /** Helper line under the control, e.g. the timezone the dates are read in. */
  hint?: React.ReactNode
  disabled?: boolean
  className?: string
}

/**
 * Date range picker: a list of presets first, with two native date inputs
 * behind "Custom dates". Native inputs give every phone its own date picker.
 */
export function DateRangeField({
  value,
  onChange,
  presets = ["today", "last7", "last30", "thisMonth"],
  maxDays,
  "aria-label": ariaLabel = "Date range",
  hint,
  disabled = false,
  className,
}: DateRangeFieldProps) {
  const id = React.useId()
  const matching = presets.find((preset) => {
    const range = presetDateRange(preset)
    return range.from === value.from && range.to === value.to
  })
  // "Custom" stays open once chosen, even if the typed dates happen to equal a preset.
  const [custom, setCustom] = React.useState(!matching)
  const [draft, setDraft] = React.useState(value)
  const [lastValue, setLastValue] = React.useState(value)
  if (lastValue.from !== value.from || lastValue.to !== value.to) {
    setLastValue(value)
    setDraft(value)
  }

  const problem = !draft.from || !draft.to
    ? "Choose both dates."
    : draft.from > draft.to
      ? "The end date must not be before the start date."
      : maxDays && dateRangeLength(draft) > maxDays
        ? `Choose ${maxDays} days or fewer.`
        : ""

  const changeDraft = (next: DateRange) => {
    setDraft(next)
    const valid = next.from && next.to && next.from <= next.to && (!maxDays || dateRangeLength(next) <= maxDays)
    if (valid && (next.from !== value.from || next.to !== value.to)) onChange(next)
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Select
          value={custom || !matching ? "custom" : matching}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === "custom") { setCustom(true); return }
            setCustom(false)
            onChange(presetDateRange(next as DateRangePreset))
          }}
        >
          <SelectTrigger className="sm:w-44" aria-label={ariaLabel}><SelectValue /></SelectTrigger>
          <SelectContent>
            {presets.map((preset) => <SelectItem key={preset} value={preset}>{presetLabels[preset]}</SelectItem>)}
            <SelectItem value="custom">Custom dates</SelectItem>
          </SelectContent>
        </Select>
        {custom || !matching ? (
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`} className="text-xs text-muted-foreground">From</Label>
              <Input id={`${id}-from`} type="date" value={draft.from} max={draft.to || undefined} disabled={disabled}
                aria-invalid={Boolean(problem) || undefined} aria-describedby={problem ? `${id}-problem` : undefined}
                onChange={(event) => changeDraft({ ...draft, from: event.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">To</Label>
              <Input id={`${id}-to`} type="date" value={draft.to} min={draft.from || undefined} disabled={disabled}
                aria-invalid={Boolean(problem) || undefined} aria-describedby={problem ? `${id}-problem` : undefined}
                onChange={(event) => changeDraft({ ...draft, to: event.target.value })} />
            </div>
          </div>
        ) : null}
      </div>
      {problem ? <p id={`${id}-problem`} role="alert" className="text-xs text-destructive">{problem}</p> : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
