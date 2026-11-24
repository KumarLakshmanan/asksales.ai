import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead Enrichment",
  description: "Enrich leads with verified contact and company details in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
