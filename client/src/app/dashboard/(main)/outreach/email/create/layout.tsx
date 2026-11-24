import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Email Campaign",
  description: "Create an email outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
