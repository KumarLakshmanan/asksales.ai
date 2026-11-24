"use client";

import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Callout } from "@/components/ui/callout";

interface WidgetErrorBoundaryProps {
  children: React.ReactNode;
  title?: string;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
}

/**
 * Keeps a malformed agent task from taking down the entire campaign route.
 * Dynamic widget forms are server-driven, so their failures need a local
 * recovery boundary instead of falling through to the dashboard boundary.
 */
export class WidgetErrorBoundary extends React.Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  state: WidgetErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WidgetErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[WidgetErrorBoundary] Widget render failed:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <Callout
        tone="danger"
        icon={AlertTriangle}
        title={this.props.title || "This task could not be displayed"}
        actions={
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry task
            </button>
        }
      >
        <span className="text-xs">
          The conversation is still available. Retry this task, or continue chatting while it is corrected.
        </span>
      </Callout>
    );
  }
}
