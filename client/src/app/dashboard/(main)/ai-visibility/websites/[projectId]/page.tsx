import { notFound } from 'next/navigation';
import { AiVisibilityWorkspace } from '@/components/ai-visibility/AiVisibilityWorkspace';

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: value } = await params;
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) notFound();
  return <AiVisibilityWorkspace view="overview" projectId={projectId} />;
}
