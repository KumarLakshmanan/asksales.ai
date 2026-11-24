import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Facebook Outreach",
  description: "Facebook Messenger outreach in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
