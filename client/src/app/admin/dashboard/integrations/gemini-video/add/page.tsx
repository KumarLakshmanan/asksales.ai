"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function GeminiVideoAddCredentialPage() {
  return <IntegrationCredentialForm platform="gemini_video" config={PLATFORM_CONFIGS.gemini_video} />;
}
