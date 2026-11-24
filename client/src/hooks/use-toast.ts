import * as React from "react";
import { toast as sonnerToast, type ExternalToast } from "sonner";

/**
 * Phase 6.2 / CLIENT-002: complete sonner wrapper.
 *
 * Adds:
 *  - `warning`, `info`, `loading` variants
 *  - a real `update` that returns the sonner toast id and lets callers
 *    swap a loading toast for a success/error toast
 *  - top-level `dismiss(id?)` and per-toast `dismiss()`
 */

export type ToastVariant = "default" | "destructive" | "success" | "warning" | "info" | "loading";

export interface ToastProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  action?: React.ReactNode;
  /**
   * Optional sonner options forwarded to the underlying call. Lets callers
   * set `duration`, `id`, `position`, etc. without losing the variant logic.
   */
  options?: ExternalToast;
}

interface ToastHandle {
  id: string | number;
  dismiss: () => void;
  /**
   * Replace this toast's content/variant. Pass a new `ToastProps` to render
   * the next state (e.g. loading → success).
   */
  update: (next: ToastProps) => ToastHandle;
}

function toMessageAndDescription(props: ToastProps): { message: string; description?: string } {
  const message = typeof props.title === "string" ? props.title : "Notification";
  const description = typeof props.description === "string" ? props.description : undefined;
  return { message, description };
}

function emit(props: ToastProps): ToastHandle {
  const { message, description } = toMessageAndDescription(props);
  const variant = props.variant ?? "default";
  const opts: ExternalToast = { description, ...(props.options ?? {}) };

  let id: string | number;
  switch (variant) {
    case "destructive":
      id = sonnerToast.error(message, opts);
      break;
    case "warning":
      id = sonnerToast.warning(message, opts);
      break;
    case "info":
      id = sonnerToast.info(message, opts);
      break;
    case "loading":
      id = sonnerToast.loading(message, opts);
      break;
    case "success":
    case "default":
    default:
      id = sonnerToast.success(message, opts);
      break;
  }

  return {
    id,
    dismiss: () => sonnerToast.dismiss(id),
    update: (next: ToastProps) => {
      // Sonner doesn't expose a single "update existing" API the way the old
      // shadcn toast did. The recommended pattern is to dismiss + re-emit.
      sonnerToast.dismiss(id);
      return emit(next);
    },
  };
}

function toast(props: ToastProps): ToastHandle {
  return emit(props);
}

function useToast() {
  return {
    toast,
    toasts: [] as ToastProps[],
    dismiss: (id?: string | number) => {
      if (id !== undefined) sonnerToast.dismiss(id);
      else sonnerToast.dismiss();
    },
  };
}

export { useToast, toast };
export type { ToastHandle };
