"use client";

import { useEffect } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";

export default function IntegrationsSubRedirect() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  useEffect(() => {
    const slug = Array.isArray(params.slug) ? params.slug.join("/") : params.slug || "";
    const qs = searchParams.toString();
    router.replace(`/dashboard/integrations/${slug}${qs ? `?${qs}` : ""}`);
  }, [router, params, searchParams]);
  return null;
}
