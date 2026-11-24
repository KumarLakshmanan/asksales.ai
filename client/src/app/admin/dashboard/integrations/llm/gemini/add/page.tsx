"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function GeminiAddCredentialPage() {
  return <IntegrationCredentialForm platform="gemini" config={PLATFORM_CONFIGS.gemini} />;
}
