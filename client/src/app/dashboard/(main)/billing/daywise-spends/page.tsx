"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import DaywiseSpends from "../_components/DaywiseSpends";

export default function DaywiseSpendsPage() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/billing")} aria-label="Back to billing">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-green-50 dark:bg-green-900/20 flex items-center justify-center">
            <CalendarDays className="w-5 h-5 text-green-600 dark:text-green-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Day-wise Spends</h1>
            <p className="text-xs text-muted-foreground">Daily credit activity and trends</p>
          </div>
        </div>
      </div>
      <DaywiseSpends />
    </div>
  );
}
