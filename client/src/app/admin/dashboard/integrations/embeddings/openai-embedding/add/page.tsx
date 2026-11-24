"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function OpenAIEmbeddingAddCredentialPage() {
  return <IntegrationCredentialForm platform="openai_embedding" config={PLATFORM_CONFIGS.openai_embedding} />;
}
