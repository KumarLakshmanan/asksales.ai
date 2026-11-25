"use client"

import * as React from "react"
import { Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

type NativeInputProps = Omit<
  React.ComponentPropsWithoutRef<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "size"
>

export interface SearchInputProps extends NativeInputProps {
  /** Accessible name. Required because a placeholder is not a label. */
  "aria-label": string
  /** Controlled value. Omit to let the component manage its own text. */
  value?: string
  defaultValue?: string
  /** Fires on every keystroke with the raw text. */
  onValueChange?: (value: string) => void
  /**
   * Fires with the trimmed query once typing pauses for `debounceMs`, and
   * immediately on Enter or clear. Use this to drive a fetch or filter.
   */
  onSearch?: (query: string) => void
  /** Pause before `onSearch` fires. 0 makes it fire on every change. */
  debounceMs?: number
  /** Shows a spinner in place of the clear button while results load. */
  loading?: boolean
  /** Label for the clear button, for localisation. */
  clearLabel?: string
  size?: "sm" | "default"
  /** Classes for the outer wrapper (width, margins); `className` styles the input. */
  wrapperClassName?: string
}

/**
 * Search field with a leading icon, clear button, Escape-to-clear and an
 * optional debounced `onSearch`. Works controlled or uncontrolled.
 */
const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      value: controlledValue,
      defaultValue = "",
      onValueChange,
      onSearch,
      debounceMs = 300,
      loading = false,
      clearLabel = "Clear search",
      size = "default",
      disabled,
      className,
      wrapperClassName,
      onKeyDown,
      ...props
    },
    forwardedRef,
  ) => {
    const isControlled = controlledValue !== undefined
    const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
    const value = isControlled ? controlledValue : uncontrolledValue

    const inputRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement)

    // Keep the latest callback without re-arming the timer when the parent re-renders.
    const onSearchRef = React.useRef(onSearch)
    React.useEffect(() => {
      onSearchRef.current = onSearch
    }, [onSearch])

    const timerRef = React.useRef<number | undefined>(undefined)
    const lastEmittedRef = React.useRef<string | null>(null)
    React.useEffect(() => () => window.clearTimeout(timerRef.current), [])

    const emitSearch = React.useCallback((raw: string, immediate: boolean) => {
      window.clearTimeout(timerRef.current)
      const query = raw.trim()
      const fire = () => {
        if (lastEmittedRef.current === query) return
        lastEmittedRef.current = query
        onSearchRef.current?.(query)
      }
      if (immediate || debounceMs <= 0) fire()
      else timerRef.current = window.setTimeout(fire, debounceMs)
    }, [debounceMs])

    // When the parent resets a controlled value (e.g. "Clear filters"), it already
    // knows the query, so cancel any pending emit and treat it as the last one sent.
    const localValueRef = React.useRef(value)
    React.useEffect(() => {
      if (!isControlled || controlledValue === localValueRef.current) return
      localValueRef.current = controlledValue
      window.clearTimeout(timerRef.current)
      lastEmittedRef.current = controlledValue.trim()
    }, [controlledValue, isControlled])

    const setValue = (next: string, immediate = false) => {
      localValueRef.current = next
      if (!isControlled) setUncontrolledValue(next)
      onValueChange?.(next)
      emitSearch(next, immediate)
    }

    const clear = () => {
      setValue("", true)
      inputRef.current?.focus()
    }

    const hasValue = value.length > 0
    const iconSize = size === "sm" ? "size-3.5" : "size-4"

    return (
      <div className={cn("relative w-full min-w-0", wrapperClassName)}>
        <Search
          className={cn(
            "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground",
            iconSize,
          )}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (event.defaultPrevented) return
            if (event.key === "Enter") {
              event.preventDefault()
              emitSearch(value, true)
            } else if (event.key === "Escape" && hasValue) {
              // Only swallow Escape when there is text, so it can still close a parent dialog.
              event.preventDefault()
              event.stopPropagation()
              clear()
            }
          }}
          className={cn(
            "flex w-full rounded-md border border-input-strong bg-field pl-9 pr-9 text-base shadow-xs transition-[border-color,box-shadow] duration-150",
            "placeholder:text-muted-foreground/[var(--input-placeholder-alpha)] hover:border-foreground/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20",
            "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm",
            // Hide the browser's own clear button; ours is consistent across engines.
            "[&::-webkit-search-cancel-button]:appearance-none",
            size === "sm" ? "h-8" : "h-10",
            className,
          )}
          {...props}
        />
        <div className="absolute inset-y-0 right-1 flex items-center">
          {loading ? (
            <Spinner size="sm" label="Searching" className="mr-2 text-muted-foreground" />
          ) : hasValue && !disabled ? (
            <button
              type="button"
              onClick={clear}
              aria-label={clearLabel}
              className={cn(size === "sm" ? "size-7" : "size-8", "inline-flex items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
            >
              <X className={iconSize} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    )
  },
)
SearchInput.displayName = "SearchInput"

export { SearchInput }
