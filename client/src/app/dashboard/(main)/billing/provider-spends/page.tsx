"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import ProviderSpends from "../_components/ProviderSpends";

export default function ProviderSpendsPage() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/billing")} aria-label="Back to billing">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center">
            <Server className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Provider Spends</h1>
            <p className="text-xs text-muted-foreground">Costs per AI and API provider</p>
          </div>
        </div>
      </div>
      <ProviderSpends />
    </div>
  );
}
