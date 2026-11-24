"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function IntegrationsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const params = searchParams.toString();
    router.replace(`/dashboard/integrations${params ? `?${params}` : ""}`);
  }, [router, searchParams]);
  return null;
}
