"use client";

import { Eye, EyeOff } from "lucide-react";

type PasswordVisibilityButtonProps = {
  inputId: string;
  visible: boolean;
  onToggle: () => void;
  // Accept complete localized action labels; do not concatenate translated fragments.
  showLabel: string;
  hideLabel: string;
};

export function PasswordVisibilityButton({
  inputId, visible, onToggle, showLabel, hideLabel,
}: PasswordVisibilityButtonProps) {
  return (
    <button
      type="button"
      aria-label={visible ? hideLabel : showLabel}
      aria-controls={inputId}
      onClick={onToggle}
      className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
    >
      {visible
        ? <EyeOff aria-hidden="true" className="h-4 w-4" />
        : <Eye aria-hidden="true" className="h-4 w-4" />}
    </button>
  );
}
