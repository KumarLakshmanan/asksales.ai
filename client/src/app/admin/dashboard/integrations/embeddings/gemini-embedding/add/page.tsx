"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function GeminiEmbeddingAddCredentialPage() {
  return <IntegrationCredentialForm platform="gemini_embedding" config={PLATFORM_CONFIGS.gemini_embedding} />;
}
