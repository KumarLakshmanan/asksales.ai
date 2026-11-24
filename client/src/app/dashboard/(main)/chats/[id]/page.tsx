"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { LoadingState } from "@/components/ui/loading-state";

export default function ChatsDetailRedirect() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  
  useEffect(() => {
    if (params.id) {
      router.replace(`/dashboard/conversations/${params.id}`);
    }
  }, [router, params.id]);
  
  return (
    <LoadingState className="min-h-[200px]" label="Opening conversation" />
  );
}
