import { redirect } from "next/navigation";

export default function LegacyWebhookPage() {
  redirect("/dashboard/integrations/facebook/events");
}
