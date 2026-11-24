import { IntegrationWebhookPage } from "@/components/integrations/IntegrationWebhookPage";

export default function WhatsappEventsPage() {
  return <IntegrationWebhookPage platform="whatsapp" platformLabel="WhatsApp Business" backHref="/dashboard/integrations/whatsapp" backLabel="Back to WhatsApp" />;
}
