import { notFound } from 'next/navigation';
import { AiVisibilityWorkspace, type AiVisibilityView } from '@/components/ai-visibility/AiVisibilityWorkspace';

const WEBSITE_VIEWS = new Set<AiVisibilityView>(['seo', 'aeo', 'geo', 'commerce', 'competitors', 'fixes', 'assets', 'reports']);

export default async function Page({ params }: { params: Promise<{ projectId: string; view: string }> }) {
  const { projectId: value, view } = await params;
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !WEBSITE_VIEWS.has(view as AiVisibilityView)) notFound();
  return <AiVisibilityWorkspace view={view as AiVisibilityView} projectId={projectId} />;
}
