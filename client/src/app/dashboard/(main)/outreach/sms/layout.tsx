import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SMS Outreach",
  description: "SMS outreach campaigns in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
