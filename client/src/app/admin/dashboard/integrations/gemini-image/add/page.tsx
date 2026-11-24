"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function GeminiImageAddCredentialPage() {
  return <IntegrationCredentialForm platform="gemini_image" config={PLATFORM_CONFIGS.gemini_image} />;
}
