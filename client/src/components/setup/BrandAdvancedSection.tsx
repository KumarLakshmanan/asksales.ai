"use client";

import type { ReactNode } from "react";
import "./brand-toolkit.css";

/** Optional guidance stays mounted so collapsing a section never loses edits. */
export function BrandAdvancedSection({ title, hint, populated = false, children }: {
  title: string;
  hint: string;
  populated?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="brand-advanced" open={populated || undefined}>
      <summary>
        <span>{title}<small>Optional · {hint}</small></span>
      </summary>
      <div className="setup-fieldset">{children}</div>
    </details>
  );
}
