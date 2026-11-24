import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support",
  description: "Customer support tickets, teams, notifications, and analytics in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
