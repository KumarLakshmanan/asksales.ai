"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function OpenRouterEmbeddingAddCredentialPage() {
  return <IntegrationCredentialForm platform="openrouter_embedding" config={PLATFORM_CONFIGS.openrouter_embedding} />;
}
