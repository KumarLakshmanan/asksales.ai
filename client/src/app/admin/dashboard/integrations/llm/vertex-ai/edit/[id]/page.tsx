"use client";

import { use } from "react";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function VertexAIEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <IntegrationCredentialForm
      platform="vertex_ai"
      config={PLATFORM_CONFIGS.vertex_ai}
      credentialId={Number(id)}
    />
  );
}
