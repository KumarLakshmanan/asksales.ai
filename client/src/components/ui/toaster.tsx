"use client"

import { Toaster as SonnerToaster } from "sonner"
import { useTheme } from "next-themes"

export function Toaster() {
  const { resolvedTheme } = useTheme()

  return (
    <SonnerToaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="top-right"
      closeButton
      toastOptions={{
        style: {
          padding: "12px 14px",
          fontSize: "14px",
        },
        // One themed surface for every toast; the tone shows in the icon colour only.
        classNames: {
          toast: "!rounded-xl !border-border !bg-popover !text-popover-foreground !shadow-pop",
          title: "!font-semibold",
          description: "!text-muted-foreground",
          actionButton: "!rounded-md !bg-primary-action !font-semibold !text-primary-foreground",
          cancelButton: "!rounded-md !bg-muted !font-semibold !text-foreground",
          closeButton: "!border-border !bg-popover !text-muted-foreground hover:!text-foreground",
          success: "[&_[data-icon]]:!text-success",
          error: "[&_[data-icon]]:!text-destructive",
          info: "[&_[data-icon]]:!text-info",
          warning: "[&_[data-icon]]:!text-warning",
        },
      }}
      duration={4000}
    />
  )
}