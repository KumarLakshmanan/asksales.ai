"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function RazorpayAddCredentialPage() {
  return <IntegrationCredentialForm platform="razorpay" config={PLATFORM_CONFIGS.razorpay} />;
}
