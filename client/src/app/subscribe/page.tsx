import { Suspense } from 'react';
import PublicLayout from '@/components/PublicLayout';
import SubscriptionManager from '@/components/pricing/SubscriptionManager';
export default function SubscribePage() {
  return <PublicLayout><div className="mx-auto w-full max-w-[1280px] px-5 pb-20 pt-32 sm:px-8"><Suspense fallback={<p>Loading billing…</p>}><SubscriptionManager showOrganizationSelector /></Suspense></div></PublicLayout>;
}
