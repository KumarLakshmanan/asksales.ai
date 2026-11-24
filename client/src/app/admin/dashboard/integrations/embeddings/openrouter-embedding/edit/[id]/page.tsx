"use client";

import { use } from "react";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function OpenRouterEmbeddingEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <IntegrationCredentialForm
      platform="openrouter_embedding"
      config={PLATFORM_CONFIGS.openrouter_embedding}
      credentialId={Number(id)}
    />
  );
}
