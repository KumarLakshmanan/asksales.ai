"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function OpenRouterAddCredentialPage() {
  return <IntegrationCredentialForm platform="openrouter" config={PLATFORM_CONFIGS.openrouter} />;
}
