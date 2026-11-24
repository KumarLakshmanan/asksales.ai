"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import CampaignSpends from "../_components/CampaignSpends";

export default function CampaignSpendsPage() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/billing")} aria-label="Back to billing">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Campaign Spends</h1>
            <p className="text-xs text-muted-foreground">Credit usage across all your chat campaigns</p>
          </div>
        </div>
      </div>
      <CampaignSpends />
    </div>
  );
}
