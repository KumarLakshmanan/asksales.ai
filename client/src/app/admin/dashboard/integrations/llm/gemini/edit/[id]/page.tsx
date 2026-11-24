"use client";

import { use } from "react";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function GeminiEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <IntegrationCredentialForm
      platform="gemini"
      config={PLATFORM_CONFIGS.gemini}
      credentialId={Number(id)}
    />
  );
}
