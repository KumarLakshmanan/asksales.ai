"use client";

import { BellRing } from "lucide-react";
import { OwnerSupportNotificationSettings } from "@/components/support/OwnerSupportNotificationSettings";
import { PageHeader } from "@/components/ui/page-header";

export default function SupportNotificationsPage() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={BellRing}
        title="Support notifications"
        subtitle="Alert the assigned team member when a support ticket needs attention."
      />
      <OwnerSupportNotificationSettings />
    </div>
  );
}
