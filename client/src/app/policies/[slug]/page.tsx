"use client";

import { useParams } from "next/navigation";
import LegalPolicyPage from "@/components/legal/LegalPolicyPage";

export default function DynamicPolicyPage() {
  const params = useParams<{ slug: string }>();
  const slug = Array.isArray(params?.slug) ? params.slug[0] : params?.slug;

  if (!slug) {
    return <LegalPolicyPage slug="privacy-policy" fallbackTitle="Policy" />;
  }

  return <LegalPolicyPage slug={slug} fallbackTitle="Policy" />;
}
