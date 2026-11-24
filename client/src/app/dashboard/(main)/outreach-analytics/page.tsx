"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Outreach analytics moved into Message tracking, which reports by day, by template and by outreach. */
export default function OutreachAnalyticsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/outreach/tracking?view=days");
  }, [router]);
  return null;
}
