"use client";
import { useParams } from 'next/navigation';
import { OutreachDetailPage } from '@/components/outreach/tracking/OutreachDetailPage';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <OutreachDetailPage id={id} />;
}
