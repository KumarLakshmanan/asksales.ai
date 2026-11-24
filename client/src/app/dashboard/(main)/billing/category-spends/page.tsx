"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import CategorySpends from "../_components/CategorySpends";

export default function CategorySpendsPage() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/billing")} aria-label="Back to billing">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-900/20 flex items-center justify-center">
            <Layers className="w-5 h-5 text-rose-600 dark:text-rose-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Category-wise Spends</h1>
            <p className="text-xs text-muted-foreground">Spending grouped by broad categories</p>
          </div>
        </div>
      </div>
      <CategorySpends />
    </div>
  );
}
