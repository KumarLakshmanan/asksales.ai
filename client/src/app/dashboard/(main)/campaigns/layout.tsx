import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Campaigns",
  description: "Manage your marketing campaigns in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
