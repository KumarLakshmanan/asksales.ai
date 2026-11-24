import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pending Approvals",
  description: "Review and approve pending actions in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
