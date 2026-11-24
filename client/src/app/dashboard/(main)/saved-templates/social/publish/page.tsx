"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SocialPublisher } from "@/components/social-publishing/SocialPublisher";

function SocialPublishRoute() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const assetId = Number(searchParams.get("assetId"));
  const from = searchParams.get("from") || "/dashboard/saved-templates/social";
  const [open, setOpen] = useState(true);

  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    return <div className="grid min-h-[560px] place-items-center p-6"><div className="max-w-sm text-center"><AlertCircle className="mx-auto h-8 w-8 text-amber-600" /><h1 className="mt-3 text-lg font-semibold">Choose a saved social post</h1><p className="mt-2 text-sm text-muted-foreground">Open Publish from a saved post so its copy and media can be reviewed.</p><Button className="mt-5" onClick={() => router.push(from)}>Return to social posts</Button></div></div>;
  }

  return <>
    <LoadingState label="Opening publisher…" className="min-h-[560px] bg-muted/10" />
    <SocialPublisher initialScheduledDate={searchParams.get("date") || undefined} assetId={assetId} open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) router.push(from); }} />
  </>;
}

export default function SocialPublishPage() {
  return <Suspense fallback={<LoadingState label="Loading publisher…" className="min-h-[560px]" />}><SocialPublishRoute /></Suspense>;
}
