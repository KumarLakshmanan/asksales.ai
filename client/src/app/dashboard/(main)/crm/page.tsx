"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoadingState } from "@/components/ui/loading-state";

export default function CRMPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/crm/contacts");
  }, [router]);

  return (
    <LoadingState size="page" className="h-full" label="Opening CRM contacts…" />
  );
}
