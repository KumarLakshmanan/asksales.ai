import AssistantEditor from '@/components/outreach/assistants/AssistantEditor';

export default async function AssistantConfigurationPage({ params }: { params: Promise<{ assistantId: string }> }) {
  const { assistantId } = await params;
  return <AssistantEditor assistantId={assistantId} />;
}
