"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoadingState } from "@/components/ui/page-state";

export default function ApprovalPendingPage() {
  const router = useRouter();
  
  useEffect(() => {
    // Redirect to the setup account-verification page
    router.replace("/setup/account-verification");
  }, [router]);

  return <PageLoadingState className="min-h-svh" label="Opening account verification…" />;
}
