"use client";
import { Suspense } from 'react';
import OutreachInbox from '@/components/outreach/inbox/OutreachInbox';
export default function InboxPage() {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading inbox…</div>}><OutreachInbox/></Suspense>;
}
