"use client";

import IntegrationDetail from "@/components/admin/IntegrationDetail";
import { IndianRupee } from "lucide-react";

export default function RazorpayIntegrationPage() {
  return (
    <IntegrationDetail
      platform="razorpay"
      platformName="Razorpay"
      icon={<IndianRupee className="h-6 w-6" />}
      color="bg-blue-600"
      description="Payment gateway for wallet recharges and wallet top-ups"
      features={["Wallet Recharge", "UPI / Cards", "NetBanking", "Payment Verification"]}
      showSecretField
      keyFieldLabel="Key ID"
      keyFieldPlaceholder="rzp_live_xxxxxxxxxxxxx"
      secretFieldLabel="Key Secret"
      secretFieldPlaceholder="Enter your Razorpay Key Secret"
    />
  );
}

