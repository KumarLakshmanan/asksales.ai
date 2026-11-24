import type { Metadata } from "next";
import BillingScope from "@/components/billing/BillingScope";

export const metadata: Metadata = {
  title: "Billing",
  description: "Manage your Ask Sales billing.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-screen-2xl px-4 py-5 sm:px-6 lg:px-8"><BillingScope>{children}</BillingScope></div>;
}
