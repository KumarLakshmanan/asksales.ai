import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Marketing Campaigns",
  description: "Manage marketing campaigns in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
