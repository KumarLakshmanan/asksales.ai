"use client";

import { Linkedin } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { IntegrationPageLayout } from "@/components/integrations/IntegrationPageLayout";
import { IntegrationSetupGuide } from "@/components/integrations/IntegrationSetupGuide";

export default function LinkedInIntegrationPage() {
  return (
    <IntegrationPageLayout
      icon={Linkedin}
      iconBgClass="bg-[#0077B5]"
      iconShadowClass="shadow-[#0077B5]/20"
      name="LinkedIn"
      subtitle="Official LinkedIn API integration"
      actions={
        <IntegrationSetupGuide
          platform="LinkedIn"
          platformColor="bg-[#0077B5]"
          docsKey="linkedin"
        />
      }
      fullWidth={
        <Alert>
          <AlertTitle>Official LinkedIn connection is not available yet</AlertTitle>
          <AlertDescription>
            This build does not include approved LinkedIn API/OAuth messaging access. LinkedIn outreach remains unavailable until the official provider integration is configured and approved.
          </AlertDescription>
        </Alert>
      }
    />
  );
}
