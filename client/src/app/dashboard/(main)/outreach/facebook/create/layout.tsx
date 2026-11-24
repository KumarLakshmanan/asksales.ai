import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Facebook Campaign",
  description: "Create a Facebook outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
