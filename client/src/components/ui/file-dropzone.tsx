"use client"

import * as React from "react"
import { AlertCircle, UploadCloud } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/format-bytes"
import { Spinner } from "@/components/ui/spinner"

export type FileRejectionReason = "file-type" | "file-too-large" | "file-empty" | "too-many-files"

export interface FileRejection {
  file: File
  reason: FileRejectionReason
  message: string
}

export interface FileValidationOptions {
  /** Same syntax as the input `accept` attribute: "image/*,.pdf,text/csv". */
  accept?: string
  /** Largest allowed file in bytes. */
  maxSize?: number
  /** Most files accepted in one pick or drop. Ignored when `multiple` is false (always 1). */
  maxFiles?: number
  multiple?: boolean
}

function matchesAccept(file: File, accept: string | undefined) {
  if (!accept?.trim()) return true
  const name = file.name.toLowerCase()
  const type = (file.type || "").toLowerCase()
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith(".")) return name.endsWith(token)
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1))
      return type === token
    })
}

const wildcardNames: Record<string, string> = { image: "Images", video: "Videos", audio: "Audio", text: "Text files" }

/** "image/*,.pdf,application/json" → "Images, PDF, JSON". */
function describeAccept(accept: string) {
  return accept
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (token.startsWith(".")) return token.slice(1).toUpperCase()
      const [type, subtype = ""] = token.split("/")
      if (subtype === "*") return wildcardNames[type] ?? `${type} files`
      return subtype.replace(/^(x-|vnd\.)/, "").split(/[.+-]/).pop()!.toUpperCase()
    })
    .join(", ")
}

/**
 * Split files into accepted and rejected using the same rules the dropzone
 * applies. Exported so server-bound code paths can re-check pasted files.
 */
export function validateFiles(files: readonly File[], options: FileValidationOptions = {}) {
  const { accept, maxSize, multiple = false } = options
  const limit = multiple ? options.maxFiles ?? Infinity : 1
  const accepted: File[] = []
  const rejected: FileRejection[] = []

  for (const file of files) {
    if (!matchesAccept(file, accept)) {
      rejected.push({ file, reason: "file-type", message: `${file.name} isn’t a supported file type.` })
    } else if (file.size === 0) {
      rejected.push({ file, reason: "file-empty", message: `${file.name} is empty.` })
    } else if (maxSize !== undefined && file.size > maxSize) {
      rejected.push({
        file,
        reason: "file-too-large",
        message: `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(maxSize)}.`,
      })
    } else if (accepted.length >= limit) {
      rejected.push({
        file,
        reason: "too-many-files",
        message: limit === 1 ? `Only one file can be added; ${file.name} was skipped.` : `Only ${limit} files can be added at once; ${file.name} was skipped.`,
      })
    } else {
      accepted.push(file)
    }
  }
  return { accepted, rejected }
}

export interface FileDropzoneProps extends FileValidationOptions {
  /** Called with the files that passed validation (never with an empty list). */
  onFilesAccepted: (files: File[]) => void
  /** Called with files that failed validation. The dropzone also lists them unless `showRejections` is false. */
  onFilesRejected?: (rejections: FileRejection[]) => void
  /** Main call to action. */
  label?: React.ReactNode
  /** Constraint summary under the label. Defaults to one built from `accept` and `maxSize`. */
  hint?: React.ReactNode
  /** An error from outside, such as a failed upload. Shown under the zone. */
  error?: React.ReactNode
  /** Blocks new files and shows a spinner, e.g. while the previous upload is in flight. */
  loading?: boolean
  loadingText?: React.ReactNode
  disabled?: boolean
  showRejections?: boolean
  /** Fixed id for the hidden input, so a separate <label> or test can target it. */
  id?: string
  name?: string
  /** Smaller single-line layout for toolbars and side panels. */
  compact?: boolean
  className?: string
}

/**
 * Drag-and-drop or click-to-browse file picker with client-side validation.
 * Uses a real (visually hidden) file input, so keyboard and screen-reader
 * users get the native “choose file” behaviour.
 */
export function FileDropzone({
  onFilesAccepted,
  onFilesRejected,
  accept,
  maxSize,
  maxFiles,
  multiple = false,
  label,
  hint,
  error,
  loading = false,
  loadingText = "Uploading…",
  disabled = false,
  showRejections = true,
  id,
  name,
  compact = false,
  className,
}: FileDropzoneProps) {
  const generatedId = React.useId()
  const inputId = id ?? `file-dropzone-${generatedId}`
  const hintId = `${inputId}-hint`
  const messagesId = `${inputId}-messages`

  const [isDragging, setIsDragging] = React.useState(false)
  const [rejections, setRejections] = React.useState<FileRejection[]>([])
  // dragenter/dragleave fire for every child element; count them to avoid flicker.
  const dragDepth = React.useRef(0)

  const inactive = disabled || loading

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const { accepted, rejected } = validateFiles(Array.from(list), { accept, maxSize, maxFiles, multiple })
    setRejections(rejected)
    if (rejected.length > 0) onFilesRejected?.(rejected)
    if (accepted.length > 0) onFilesAccepted(accepted)
  }

  const defaultHint = React.useMemo(() => {
    const parts: string[] = []
    if (accept) parts.push(describeAccept(accept))
    if (maxSize !== undefined) parts.push(`up to ${formatBytes(maxSize)}${multiple ? " each" : ""}`)
    if (multiple && maxFiles !== undefined) parts.push(`max ${maxFiles} files`)
    return parts.join(" · ")
  }, [accept, maxSize, maxFiles, multiple])

  const resolvedHint = hint ?? (defaultHint || null)
  const resolvedLabel = label ?? (
    <>
      <span className="text-primary">Choose {multiple ? "files" : "a file"}</span> or drag {multiple ? "them" : "it"} here
    </>
  )

  const hasMessages = Boolean(error) || (showRejections && rejections.length > 0)
  const describedBy = [resolvedHint ? hintId : null, hasMessages ? messagesId : null].filter(Boolean).join(" ") || undefined

  return (
    <div className={cn("w-full", className)}>
      <label
        htmlFor={inputId}
        data-dragging={isDragging || undefined}
        data-disabled={inactive || undefined}
        aria-busy={loading || undefined}
        onDragEnter={(event) => {
          event.preventDefault()
          if (inactive) return
          dragDepth.current += 1
          setIsDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = inactive ? "none" : "copy"
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setIsDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setIsDragging(false)
          if (!inactive) handleFiles(event.dataTransfer.files)
        }}
        className={cn(
          "relative flex w-full cursor-pointer rounded-2xl border-2 border-dashed border-border bg-card text-center transition-colors",
          "hover:border-primary/50 hover:bg-primary/[0.02]",
          "has-[input:focus-visible]:border-primary has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/30",
          "data-[dragging]:border-primary data-[dragging]:bg-primary/[0.06]",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[disabled]:hover:border-border data-[disabled]:hover:bg-card",
          (error || rejections.length > 0) && !isDragging && "border-destructive/50",
          compact ? "items-center gap-3 px-4 py-3 text-left" : "flex-col items-center justify-center gap-2 px-6 py-10",
        )}
      >
        <input
          id={inputId}
          name={name}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          disabled={inactive}
          aria-describedby={describedBy}
          onChange={(event) => {
            handleFiles(event.target.files)
            // Clear so picking the same file again still fires change.
            event.target.value = ""
          }}
        />
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
            compact ? "size-9" : "size-12",
          )}
          aria-hidden="true"
        >
          {loading ? <Spinner size={compact ? "sm" : "md"} label={null} /> : <UploadCloud className={compact ? "size-4" : "size-6"} />}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-foreground">
            {loading ? <span role="status">{loadingText}</span> : isDragging ? `Drop to add ${multiple ? "files" : "file"}` : resolvedLabel}
          </span>
          {resolvedHint ? (
            <span id={hintId} className="text-xs text-muted-foreground">
              {resolvedHint}
            </span>
          ) : null}
        </span>
      </label>

      <div id={messagesId} aria-live="polite">
        {hasMessages ? (
          <ul className="mt-2 space-y-1 text-sm text-destructive">
            {error ? (
              <li className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </li>
            ) : null}
            {showRejections
              ? rejections.map((rejection, index) => (
                  <li key={`${rejection.file.name}-${index}`} className="flex items-start gap-1.5">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">{rejection.message}</span>
                  </li>
                ))
              : null}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
