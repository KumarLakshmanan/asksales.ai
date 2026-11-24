"use client";

import { PageErrorState } from "@/components/ui/page-state";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageErrorState error={error} reset={reset} digest={error.digest} />;
}
