"use client";

import { use } from "react";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function OpenAIEmbeddingEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <IntegrationCredentialForm
      platform="openai_embedding"
      config={PLATFORM_CONFIGS.openai_embedding}
      credentialId={Number(id)}
    />
  );
}
