import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Paid Ads",
  description: "Manage paid campaigns, performance, recommendations, and AI automation in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
