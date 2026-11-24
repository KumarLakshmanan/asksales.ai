'use client';
import { useParams } from 'next/navigation';
import { AiVisibilityAuditDetail } from '@/components/ai-visibility/AiVisibilityWorkspace';
export default function Page() {
  const params = useParams<{ auditId: string }>();
  return <AiVisibilityAuditDetail auditId={Number(params.auditId)} />;
}
