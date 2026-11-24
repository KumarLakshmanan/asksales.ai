"use client";

import { useParams } from "next/navigation";
import WhatsAppTemplateEditor from "@/components/whatsapp-templates/WhatsAppTemplateEditor";

export default function EditWhatsAppTemplatePage() {
  const params = useParams<{ id: string }>();
  return (
    <WhatsAppTemplateEditor
      templateId={params.id}
      templatesPath="/dashboard/integrations/whatsapp/templates"
    />
  );
}
