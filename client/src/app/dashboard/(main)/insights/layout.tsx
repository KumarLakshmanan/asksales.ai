import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Insights",
  description: "Usage, customer activity, and verified outcomes for this business in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
