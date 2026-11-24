"use client";

import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

export default function ZeroBounceAddCredentialPage() {
  return <IntegrationCredentialForm platform="zerobounce" config={PLATFORM_CONFIGS.zerobounce} />;
}
