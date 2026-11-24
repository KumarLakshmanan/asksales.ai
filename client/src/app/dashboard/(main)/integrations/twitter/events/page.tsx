import { IntegrationWebhookPage } from "@/components/integrations/IntegrationWebhookPage";

export default function TwitterEventsPage() {
  return <IntegrationWebhookPage platform="twitter" platformLabel="Twitter / X" backHref="/dashboard/integrations/twitter" backLabel="Back to Twitter" />;
}
