"use client";

import { use } from "react";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function RazorpayEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <IntegrationCredentialForm
      platform="razorpay"
      config={PLATFORM_CONFIGS.razorpay}
      credentialId={Number(id)}
    />
  );
}
