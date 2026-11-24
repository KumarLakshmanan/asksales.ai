import { redirect } from "next/navigation";

export default async function LegacyWhatsAppTemplateDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/integrations/whatsapp/templates/${id}`);
}
