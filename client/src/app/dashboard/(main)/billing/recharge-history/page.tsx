"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import RechargeHistory from "../_components/RechargeHistory";

export default function RechargeHistoryPage() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <PageHeader
        icon={CreditCard}
        title="Recharge History"
        subtitle="Review completed wallet top-ups and their payment references"
        actions={
          <Button variant="outline" size="sm" onClick={() => router.push("/dashboard/billing")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to billing
          </Button>
        }
      />
      <RechargeHistory />
    </div>
  );
}
