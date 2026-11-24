"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function OpenAIAddCredentialPage() {
  return <IntegrationCredentialForm platform="openai" config={PLATFORM_CONFIGS.openai} />;
}
