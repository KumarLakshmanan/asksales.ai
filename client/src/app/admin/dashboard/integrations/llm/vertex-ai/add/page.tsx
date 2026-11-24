"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function VertexAIAddCredentialPage() {
  return <IntegrationCredentialForm platform="vertex_ai" config={PLATFORM_CONFIGS.vertex_ai} />;
}
