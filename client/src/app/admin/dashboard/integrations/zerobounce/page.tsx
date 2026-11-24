"use client";

import IntegrationDetail from "@/components/admin/IntegrationDetail";
import { ShieldCheck } from "lucide-react";

export default function ZeroBounceIntegrationPage() {
  return (
    <IntegrationDetail
      platform="zerobounce"
      platformName="ZeroBounce"
      icon={<ShieldCheck className="h-6 w-6" />}
      color="bg-cyan-500"
      description="Email validation and verification service"
      features={["Email Validation", "Bounce Prevention", "Deliverability"]}
    />
  );
}
