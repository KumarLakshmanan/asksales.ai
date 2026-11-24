"use client";
import {useParams} from 'next/navigation';
import {Suspense} from 'react';
import {PreparedOutreachPage} from '@/components/outreach/create/PreparedOutreachPage';
export default function Page() {
  const {id}=useParams<{id:string}>();
  return <Suspense fallback={<p className="p-6">Loading prepared outreach…</p>}><PreparedOutreachPage id={id}/></Suspense>;
}
