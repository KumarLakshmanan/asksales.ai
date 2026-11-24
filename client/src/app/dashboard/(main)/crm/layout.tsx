import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CRM",
  description: "Contacts, pipeline, follow-ups, and reports for your sales team in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
