"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { isPageChunkError, reloadCurrentPage } from '@/lib/page-error-recovery';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /** Optional section name shown in the error UI */
  section?: string;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught error:", error, info.componentStack);
  }

  handleReset = () => {
    if (isPageChunkError(this.state.error)) { reloadCurrentPage(); return; }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const label = this.props.section ?? "This section";

      return (
        <div className="flex flex-col items-center justify-center gap-4 p-10 text-center min-h-[200px]">
          <AlertTriangle className="w-10 h-10 text-amber-500" />
          <div>
            <p className="text-base font-semibold text-foreground">
              {label} ran into a problem
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {isPageChunkError(this.state.error) ? 'A page update could not be downloaded. Reload to get the latest version.' : 'An unexpected error occurred. Please try again.'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={this.handleReset}
            className="gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            {isPageChunkError(this.state.error) ? 'Reload page' : 'Try again'}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
