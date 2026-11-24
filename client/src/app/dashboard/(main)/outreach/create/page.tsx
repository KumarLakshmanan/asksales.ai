import { Suspense } from "react";
import { OutreachCreationPage } from "@/components/outreach/create/OutreachCreationPage";

export default function NewOutreachPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-muted-foreground">
          Loading outreach composer…
        </div>
      }
    >
      <OutreachCreationPage />
    </Suspense>
  );
}
