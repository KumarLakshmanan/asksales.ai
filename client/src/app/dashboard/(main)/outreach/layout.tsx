import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Outreach",
  description: "Multi-channel outreach in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
