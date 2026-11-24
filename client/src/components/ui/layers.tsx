"use client"

import * as React from "react"

// React ownership survives a body portal; DOM/CSS ancestry does not. Each modal
// reserves a level for its floating controls before the next nested modal.
const ModalDepth = React.createContext(0)

export function ModalLayerScope({ children }: { children: React.ReactNode }) {
  const depth = React.useContext(ModalDepth)
  return <ModalDepth.Provider value={depth + 1}>{children}</ModalDepth.Provider>
}

type LayerStyle = React.CSSProperties & { "--ui-layer": string }

export function useModalLayerStyle(style?: React.CSSProperties): LayerStyle {
  const depth = React.useContext(ModalDepth)
  return {
    ...style,
    "--ui-layer": `calc(var(--layer-modal) + ${depth} * var(--layer-modal-step))`,
  }
}

export function useFloatingLayerStyle(style?: React.CSSProperties): LayerStyle {
  const depth = React.useContext(ModalDepth)
  return {
    ...style,
    "--ui-layer": depth
      ? `calc(var(--layer-modal) + ${depth - 1} * var(--layer-modal-step) + var(--layer-modal-floating-offset))`
      : "var(--layer-floating)",
  }
}
