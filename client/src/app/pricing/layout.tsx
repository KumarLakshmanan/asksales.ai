import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Compare ${BRAND_NAME} organization plans, monthly credits and shared capacity for your businesses and workspaces. Choose monthly or yearly billing.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
