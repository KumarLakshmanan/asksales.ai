import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead Details",
  description: "View detailed information about a lead in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
