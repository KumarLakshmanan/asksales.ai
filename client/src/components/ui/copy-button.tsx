"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"

type CopySource = string | (() => string | Promise<string>)

/**
 * Writes text to the clipboard. Falls back to execCommand outside secure
 * contexts (plain-HTTP staging) and when the async API is denied.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Permission denied or document not focused: try the legacy path below.
    }
  }
  legacyCopy(text)
}

function legacyCopy(text: string) {
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  const previousFocus = document.activeElement as HTMLElement | null
  textarea.select()
  try {
    if (!document.execCommand("copy")) throw new Error("Copy command was rejected")
  } finally {
    document.body.removeChild(textarea)
    previousFocus?.focus()
  }
}

export type CopyStatus = "idle" | "copied" | "error"

/**
 * Copy state machine shared by CopyButton and custom copy UIs.
 * `status` returns to "idle" after `resetMs`.
 */
export function useCopyToClipboard({ resetMs = 2000 }: { resetMs?: number } = {}) {
  const [status, setStatus] = React.useState<CopyStatus>("idle")
  const timer = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = React.useCallback(
    async (source: CopySource) => {
      window.clearTimeout(timer.current)
      try {
        const text = typeof source === "function" ? await source() : source
        await copyText(text)
        setStatus("copied")
        timer.current = window.setTimeout(() => setStatus("idle"), resetMs)
        return true
      } catch {
        setStatus("error")
        timer.current = window.setTimeout(() => setStatus("idle"), resetMs * 2)
        return false
      }
    },
    [resetMs],
  )

  return { status, copy }
}

export interface CopyButtonProps extends Omit<ButtonProps, "value" | "onClick" | "children" | "onError"> {
  /** Text to copy, or a function that produces it (may be async). */
  value: CopySource
  /** Visible label. Also used as the accessible name for icon-only buttons. */
  label?: string
  copiedLabel?: string
  errorLabel?: string
  /** Hide the text and show only the icon (the label stays as the accessible name). */
  iconOnly?: boolean
  onCopied?: () => void
  onError?: () => void
}

/**
 * Button that copies text and confirms in place (“Copied”), with the result
 * announced to screen readers. Use for API keys, links, embed snippets and IDs.
 */
const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      value,
      label = "Copy",
      copiedLabel = "Copied",
      errorLabel = "Couldn’t copy",
      iconOnly = false,
      onCopied,
      onError,
      variant = "outline",
      size,
      className,
      ...props
    },
    ref,
  ) => {
    const { status, copy } = useCopyToClipboard()
    const current = status === "copied" ? copiedLabel : status === "error" ? errorLabel : label
    const Icon = status === "copied" ? Check : Copy

    return (
      <>
        <Button
          ref={ref}
          type="button"
          variant={variant}
          size={size ?? (iconOnly ? "icon" : "sm")}
          aria-label={iconOnly ? current : undefined}
          className={cn(status === "error" && "text-destructive", className)}
          onClick={async () => {
            const ok = await copy(value)
            if (ok) onCopied?.()
            else onError?.()
          }}
          {...props}
        >
          <Icon className={cn(status === "copied" && "text-success")} aria-hidden="true" />
          {iconOnly ? null : <span>{current}</span>}
        </Button>
        {/* Visible text changes are not reliably announced, so say it explicitly.
            Kept outside the button so it doesn't double the button's name.
            sr-only is absolutely positioned, so it never affects flex/grid gaps. */}
        <span className="sr-only" aria-live="polite">
          {status === "idle" ? "" : current}
        </span>
      </>
    )
  },
)
CopyButton.displayName = "CopyButton"

export { CopyButton }
