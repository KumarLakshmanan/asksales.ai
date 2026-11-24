"use client";

import WhatsAppTemplateEditor from "@/components/whatsapp-templates/WhatsAppTemplateEditor";

export default function CreateWhatsAppTemplatePage() {
  return (
    <WhatsAppTemplateEditor templatesPath="/dashboard/integrations/whatsapp/templates" />
  );
}
