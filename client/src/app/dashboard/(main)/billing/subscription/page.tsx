import { Suspense } from 'react';
import SubscriptionManager from '@/components/pricing/SubscriptionManager';
export default function SubscriptionPage() {
  return <Suspense fallback={<p>Loading billing…</p>}><SubscriptionManager /></Suspense>;
}
