"use client";

import { useParams, useSearchParams } from "next/navigation";
import { SocialPostDetail } from "@/components/social-insights/SocialPostDetail";

export default function SocialPostPage() {
  const params = useParams<{ id: string }>();
  const query = useSearchParams();
  return (
    <SocialPostDetail
      key={`${params.id}:${query.get("account")}:${query.get("platform")}`}
      postId={params.id}
      credentialId={query.get("account") || ""}
      platform={query.get("platform") || "instagram"}
      startDate={query.get("start") || ""}
      endDate={query.get("end") || ""}
    />
  );
}
