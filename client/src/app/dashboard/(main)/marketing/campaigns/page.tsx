"use client";

import { paidAdsReturnHref } from '@/components/performance-marketing/campaignRoutes';
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function MarketingCampaignsRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString();
  useEffect(() => {
    const next = new URLSearchParams(search);
    next.set('tab', 'campaigns');
    router.replace(paidAdsReturnHref(`/dashboard/ads?${next}`));
  }, [router, search]);
  return null;
}
