"use client";

import { useParams } from 'next/navigation';
import { ProposalEditor } from '@/components/proposals/ProposalEditor';
export default function ProposalEditPage() {
  const params = useParams();
  return <ProposalEditor proposalId={Number(params.id)} />;
}
