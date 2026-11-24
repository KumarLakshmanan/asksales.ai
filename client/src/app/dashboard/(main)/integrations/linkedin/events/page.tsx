import { IntegrationWebhookPage } from "@/components/integrations/IntegrationWebhookPage";

export default function LinkedinEventsPage() {
  return <IntegrationWebhookPage platform="linkedin" platformLabel="LinkedIn" backHref="/dashboard/integrations/linkedin" backLabel="Back to LinkedIn" />;
}
