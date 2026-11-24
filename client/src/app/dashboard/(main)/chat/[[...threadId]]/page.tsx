"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { LoadingState } from "@/components/ui/loading-state";

/**
 * Chat page redirects to conversations page which has the full
 * campaign layout with sidebar tabs, CampaignChatHeader, and ChromeTabs.
 */
export default function ChatPage() {
  const router = useRouter();
  const params = useParams();
  const threadId = params?.threadId;

  useEffect(() => {
    if (threadId) {
      router.replace(`/dashboard/conversations/${threadId}`);
    } else {
      router.replace("/dashboard/conversations");
    }
  }, [threadId, router]);

  return (
    <LoadingState className="h-full min-h-[200px]" label="Opening conversations…" />
  );
}
