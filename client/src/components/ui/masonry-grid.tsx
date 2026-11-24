"use client";

import React from "react";

interface MasonryGridProps {
  children: React.ReactNode;
  /** Maximum number of columns at largest breakpoint */
  columns?: 2 | 3 | 4;
  /** Gap between items in pixels */
  gap?: number;
  className?: string;
}

/**
 * Pinterest-style masonry grid using CSS columns.
 * Cards flow top-to-bottom, then left-to-right, creating the waterfall effect.
 */
export function MasonryGrid({
  children,
  columns = 3,
  gap = 16,
  className = "",
}: MasonryGridProps) {
  // Viewport breakpoints do not reflect the width of a split-panel gallery.
  // Let the browser reduce the column count from the requested maximum when
  // the grid's own container is too narrow instead.
  const minColumnWidth = columns === 4 ? 240 : 280;

  return (
    <div
      className={`w-full min-w-0 ${className}`}
      style={{
        columnCount: columns,
        columnGap: `${gap}px`,
        columnWidth: `${minColumnWidth}px`,
      }}
    >
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        return (
          <div
            className="min-w-0 break-inside-avoid"
            style={{ marginBottom: `${gap}px` }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}

export default MasonryGrid;
