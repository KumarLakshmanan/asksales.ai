import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Leads",
  description: "Manage and track your leads in Ask Sales. View, filter, and take action on your pipeline.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
