import { Suspense } from "react";
import { OutreachRetryView } from "@/components/outreach/reports/OutreachRetryView";
export default function RetryPage() {
  return (
    <Suspense fallback={<p className="p-6">Loading retry review…</p>}>
      <OutreachRetryView />
    </Suspense>
  );
}
