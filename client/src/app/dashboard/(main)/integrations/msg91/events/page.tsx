import { IntegrationWebhookPage } from "@/components/integrations/IntegrationWebhookPage";

export default function MSG91EventsPage() {
  return <IntegrationWebhookPage platform="msg91" platformLabel="MSG91 SMS" backHref="/dashboard/integrations/msg91" backLabel="SMS integration" />;
}
