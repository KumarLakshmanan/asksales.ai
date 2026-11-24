"use client";

import Link from "next/link";
import { Megaphone, Target } from "lucide-react";

import PerformanceMarketingDashboard from "@/components/PerformanceMarketingDashboard";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";

interface PerformanceMarketingTabProps {
  icpId?: number;
  icpStatus?: 'loading' | 'ready' | 'error';
  onRetryIcp?: () => void;
  threadId?: number;
  onSendMessage?: (message: string) => void;
}

export default function PerformanceMarketingTab({ icpId, icpStatus = 'ready', onRetryIcp, onSendMessage }: PerformanceMarketingTabProps) {
  if (icpStatus === 'loading') return (
    <LoadingState label="Loading campaign context…" showLabel className="h-full min-h-80 bg-background" />
  );
  if (icpStatus === 'error') return (
    <div role="alert" className="flex h-full min-h-80 flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm">
      <p>The campaign’s customer profile could not be loaded.</p>
      {onRetryIcp && <Button variant="outline" onClick={onRetryIcp}>Retry campaign context</Button>}
    </div>
  );
  if (!icpId) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Target className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold">ICP required for campaign planning</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Generate or select an ideal customer profile in this conversation before building budgets, audiences, and ads.
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            {onSendMessage && (
              <Button
                type="button"
                onClick={() => onSendMessage("Help me create an ideal customer profile for a performance marketing campaign.")}
              >
                Create an ICP
              </Button>
            )}
            <Button asChild variant={onSendMessage ? "outline" : "default"}>
              <Link href="/dashboard/ads?tab=campaigns">
                <Megaphone className="mr-2 h-4 w-4" />
                Open campaign manager
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background p-3 sm:p-4">
      <PerformanceMarketingDashboard icpId={icpId} />
    </div>
  );
}
