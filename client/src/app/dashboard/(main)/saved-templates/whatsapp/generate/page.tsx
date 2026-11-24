import { redirect } from "next/navigation";

export default function LegacyCreateWhatsAppTemplatePage() {
  redirect("/dashboard/integrations/whatsapp/templates/create");
}
