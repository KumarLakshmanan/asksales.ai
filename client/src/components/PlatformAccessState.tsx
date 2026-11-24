"use client";

import { AlertTriangle, Clock3, RefreshCw, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PlatformAccessStateProps {
  kind: "maintenance" | "unavailable" | "error";
  title: string;
  message: string;
  onRetry?: () => void;
}

export function PlatformAccessState({ kind, title, message, onRetry }: PlatformAccessStateProps) {
  const Icon = kind === "maintenance" ? Clock3 : kind === "unavailable" ? ShieldOff : AlertTriangle;
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-svh items-center justify-center bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="w-full max-w-lg rounded-2xl border border-border/70 bg-card p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
        {onRetry && (
          <Button onClick={onRetry} variant="outline" className="mt-6">
            <RefreshCw className="mr-2 h-4 w-4" />
            Try again
          </Button>
        )}
      </section>
    </main>
  );
}
