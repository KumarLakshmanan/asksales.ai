import { IntegrationWebhookPage } from "@/components/integrations/IntegrationWebhookPage";

export default function FacebookEventsPage() {
  return <IntegrationWebhookPage platform="facebook" platformLabel="Facebook" backHref="/dashboard/integrations/facebook" backLabel="Back to Facebook" />;
}
