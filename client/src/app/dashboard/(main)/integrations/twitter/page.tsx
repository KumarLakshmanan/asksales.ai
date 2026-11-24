"use client";

import { Twitter } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { IntegrationSetupGuide } from "@/components/integrations/IntegrationSetupGuide";

export default function TwitterIntegrationPage() {
  return (
    <IntegrationPageLayout
      icon={Twitter}
      iconBgClass="bg-black"
      iconShadowClass="shadow-black/20"
      name="Twitter / X"
      subtitle="Official X API integration"
      actions={
        <IntegrationSetupGuide platform="X" platformColor="bg-black" docsKey="twitter" />
      }
      fullWidth={
        <Alert>
          <AlertTitle>Official X connection is not available yet</AlertTitle>
          <AlertDescription>
            This build does not include an approved X API/OAuth connection. X outreach remains unavailable until the official provider integration is configured.
          </AlertDescription>
        </Alert>
      }
    />
  );
}
